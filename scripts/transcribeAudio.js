import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import Groq from 'groq-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const CHUNK_SIZE_MB = 19;
const CHUNK_SIZE_BYTES = CHUNK_SIZE_MB * 1024 * 1024;
const OVERLAP_SECONDS = 10;

// ─── 429 helpers ───────────────────────────────
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;
let _useLocalWhisper = false;   // sticky — once 429, stay local for the run

function is429(error) {
    return error?.status === 429 ||
        error?.statusCode === 429 ||
        error?.error?.code === 'rate_limit_exceeded' ||
        String(error?.message).includes('429');
}

function parseRetryAfter(error) {
    const msg = error?.error?.message || error?.message || '';
    const match = msg.match(/try again in ([\d.]+)s/i);
    return match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────
// Get audio duration
// ──────────────────────────────────────────────
async function getAudioDuration(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata.format.duration);
        });
    });
}

// ──────────────────────────────────────────────
// Chunk audio — writes to disk inside chunksDir
// ──────────────────────────────────────────────
async function chunkAudio(inputPath, chunksDir) {
    await fs.ensureDir(chunksDir);

    console.log('🔍 Analyzing audio file...');
    const duration = await getAudioDuration(inputPath);
    const fileSizeBytes = (await fs.stat(inputPath)).size;
    const bytesPerSecond = fileSizeBytes / duration;
    const chunkDuration = Math.floor(CHUNK_SIZE_BYTES / bytesPerSecond);

    console.log(`📊 File size:      ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`⏱  Duration:       ${duration.toFixed(1)}s`);
    console.log(`✂️  Chunk duration: ~${chunkDuration}s with ${OVERLAP_SECONDS}s overlap`);

    const chunks = [];
    let start = 0;
    let index = 0;

    while (start < duration) {
        const chunkPath = path.join(chunksDir, `chunk_${String(index).padStart(3, '0')}.mp3`);

        console.log(`\n🔪 Creating chunk ${index + 1}: ${start.toFixed(1)}s → ${Math.min(start + chunkDuration, duration).toFixed(1)}s`);

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .setStartTime(start)
                .setDuration(chunkDuration + OVERLAP_SECONDS)
                .output(chunkPath)
                .on('end', () => {
                    const chunkSize = fs.statSync(chunkPath).size / 1024 / 1024;
                    console.log(`   ✅ Saved: ${path.basename(chunkPath)} (${chunkSize.toFixed(1)} MB)`);
                    resolve();
                })
                .on('error', reject)
                .run();
        });

        chunks.push({ path: chunkPath, start, end: Math.min(start + chunkDuration, duration), index });
        start += chunkDuration;
        index++;
    }

    console.log(`\n✅ Created ${chunks.length} chunks in: ${chunksDir}`);
    return chunks;
}

// ──────────────────────────────────────────────
// Transcribe each chunk — with retry + local fallback
// ──────────────────────────────────────────────
async function transcribeChunk(chunk, total) {
    console.log(`\n🎙  Transcribing chunk ${chunk.index + 1}/${total}: ${path.basename(chunk.path)}`);

    // If a previous chunk already hit persistent 429, go straight to local
    if (_useLocalWhisper) {
        return transcribeChunkLocal(chunk, total);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const transcription = await groq.audio.transcriptions.create({
                file: fs.createReadStream(chunk.path),
                model: 'whisper-large-v3-turbo',
                temperature: 0,
                response_format: 'verbose_json',
                timestamp_granularities: ['segment'],
            });

            console.log(`   ✅ Transcribed ${transcription.segments?.length ?? 0} segments`);
            return transcription;
        } catch (error) {
            if (is429(error) && attempt < MAX_RETRIES) {
                const wait = parseRetryAfter(error) || RETRY_DELAY_MS * (attempt + 1);
                console.warn(`   ⚠️  Groq 429 — retry ${attempt + 1}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s...`);
                await sleep(wait);
                continue;
            }
            if (is429(error)) {
                console.warn('   ⚠️  Groq Whisper rate-limited — switching to local whisper-small for remaining chunks...');
                _useLocalWhisper = true;
                return transcribeChunkLocal(chunk, total);
            }
            throw error;
        }
    }
}

async function transcribeChunkLocal(chunk, total) {
    try {
        const { localTranscribe } = await import('../clients/local_fallback.js');
        const result = await localTranscribe(chunk.path);
        console.log(`   ✅ Local whisper: ${result.segments?.length ?? 0} segments`);
        return result;
    } catch (fbErr) {
        console.error(`   ❌ Local whisper fallback failed: ${fbErr.message}`);
        throw fbErr;
    }
}

// ──────────────────────────────────────────────
// Merge transcripts with corrected timestamps
// ──────────────────────────────────────────────
function mergeTranscripts(chunks, transcriptions) {
    let allSegments = [];
    let lastEndTime = 0;

    for (let i = 0; i < transcriptions.length; i++) {
        const chunk = chunks[i];
        const segments = transcriptions[i].segments ?? [];

        for (const segment of segments) {
            const adjustedStart = chunk.start + segment.start;
            const adjustedEnd = chunk.start + segment.end;

            if (adjustedStart < lastEndTime - 1) continue;

            allSegments.push({
                ...segment,
                start: adjustedStart,
                end: adjustedEnd,
                text: segment.text.trim(),
            });

            lastEndTime = adjustedEnd;
        }
    }

    const fullText = allSegments
        .map(s => {
            const mins = Math.floor(s.start / 60);
            const secs = Math.floor(s.start % 60).toString().padStart(2, '0');
            return `(${mins}:${secs}) ${s.text}`;
        })
        .join('\n');

    return { fullText, segments: allSegments };
}

// ──────────────────────────────────────────────
// Cleanup: delete entire chunks dir after merge
// ──────────────────────────────────────────────
async function cleanupChunks(chunksDir) {
    try {
        await fs.remove(chunksDir);
        console.log(`🧹 Deleted chunks dir: ${chunksDir}`);
    } catch (err) {
        console.warn(`⚠️  Could not delete chunks dir: ${err.message}`);
    }
}

// ──────────────────────────────────────────────
// Resolve output dir from audio path
//
// inputs/{company}/audio/demo.mp3
//   → inputs/{company}/transcripts/demo/
//
// inputs/{company}/audio/demo/demo_audio.mp3
//   → inputs/{company}/transcripts/demo/
//
// Rule: walk up from the audio file until we find
// the folder named "audio", take the stem above it
// as company dir, use the FIRST subfolder under
// "audio" (or the filename stem) as the session name.
// ──────────────────────────────────────────────
function resolveOutputDir(inputAudioAbs) {
    const parts = inputAudioAbs.split(path.sep);

    // Find index of the "audio" segment
    const audioIdx = parts.findLastIndex(p => p.toLowerCase() === 'audio');

    if (audioIdx === -1) {
        throw new Error(`Could not find an "audio" folder in path: ${inputAudioAbs}`);
    }

    // Company dir is everything up to (not including) "audio"
    const companyDir = parts.slice(0, audioIdx).join(path.sep);

    // Session name = first path segment after "audio"
    // e.g. audio/demo.mp3        → "demo"
    // e.g. audio/demo/file.mp3   → "demo"
    const afterAudio = parts.slice(audioIdx + 1);
    const sessionName = afterAudio.length === 1
        ? path.basename(afterAudio[0], path.extname(afterAudio[0]))  // "demo.mp3" → "demo"
        : afterAudio[0];                                              // "demo/..." → "demo"

    return path.join(companyDir, 'transcripts', sessionName);
}

// ──────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────
async function main() {
    const inputAudio = process.argv[2];

    if (!inputAudio) {
        console.error('❌ Usage: node scripts/transcribeAudio.js <path-to-audio-file>');
        console.error('   Example: node scripts/transcribeAudio.js inputs/fireflies/audio/demo.mp3');
        process.exit(1);
    }

    if (!await fs.pathExists(inputAudio)) {
        console.error(`❌ Audio file not found: ${inputAudio}`);
        process.exit(1);
    }

    const inputAudioAbs = path.resolve(inputAudio);
    const outputDir     = resolveOutputDir(inputAudioAbs);
    const chunksDir     = path.join(outputDir, 'chunks');

    await fs.ensureDir(outputDir);

    console.log('═══════════════════════════════════════');
    console.log('🎵 AUDIO TRANSCRIPTION PIPELINE');
    console.log('═══════════════════════════════════════');
    console.log(`📂 Input:      ${inputAudioAbs}`);
    console.log(`📂 Output dir: ${outputDir}`);
    console.log(`📂 Chunks dir: ${chunksDir}  (deleted after merge)`);
    console.log('═══════════════════════════════════════\n');

    // Step 1: Chunk audio → written to disk
    console.log('STEP 1: CHUNKING AUDIO');
    console.log('───────────────────────');
    const chunks = await chunkAudio(inputAudioAbs, chunksDir);

    // Step 2: Transcribe each chunk from disk
    console.log('\nSTEP 2: TRANSCRIBING CHUNKS');
    console.log('───────────────────────────');
    const transcriptions = [];
    for (const chunk of chunks) {
        const transcription = await transcribeChunk(chunk, chunks.length);
        transcriptions.push(transcription);
    }

    // Step 3: Merge
    console.log('\nSTEP 3: MERGING TRANSCRIPTS');
    console.log('────────────────────────────');
    const { fullText, segments } = mergeTranscripts(chunks, transcriptions);

    const transcriptPath = path.join(outputDir, 'transcript.txt');
    const segmentsPath   = path.join(outputDir, 'transcript_segments.json');

    await fs.writeFile(transcriptPath, fullText);
    await fs.writeJson(segmentsPath, segments, { spaces: 2 });
    console.log('✅ Merged transcript saved');

    // Step 4: Delete chunks dir
    console.log('\nSTEP 4: CLEANUP');
    console.log('────────────────');
    await cleanupChunks(chunksDir);

    console.log('\n═══════════════════════════════════════');
    console.log('✅ TRANSCRIPTION COMPLETE');
    console.log('═══════════════════════════════════════');
    console.log(`📄 Transcript:       ${transcriptPath}`);
    console.log(`📋 Segments JSON:    ${segmentsPath}`);
    console.log(`🔢 Total segments:   ${segments.length}`);
    console.log(`📦 Chunks processed: ${chunks.length} (deleted)`);
    console.log('═══════════════════════════════════════\n');

    console.log('📝 TRANSCRIPT PREVIEW:');
    console.log('───────────────────────');
    console.log(fullText.slice(0, 500) + '...\n');
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});