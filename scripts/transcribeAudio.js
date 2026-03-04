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
// Chunk audio
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
        const end = Math.min(start + chunkDuration, duration);

        console.log(`\n🔪 Creating chunk ${index + 1}: ${start.toFixed(1)}s → ${end.toFixed(1)}s`);

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

        chunks.push({ path: chunkPath, start, end, index });
        start += chunkDuration;
        index++;
    }

    console.log(`\n✅ Created ${chunks.length} chunks`);
    return chunks;
}

// ──────────────────────────────────────────────
// Transcribe each chunk
// ──────────────────────────────────────────────
async function transcribeChunk(chunk, total) {
    console.log(`\n🎙  Transcribing chunk ${chunk.index + 1}/${total}: ${path.basename(chunk.path)}`);

    const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(chunk.path),
        model: 'whisper-large-v3-turbo',
        temperature: 0,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
    });

    console.log(`   ✅ Transcribed ${transcription.segments?.length ?? 0} segments`);
    return transcription;
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
            const secs = (s.start % 60).toFixed(0).padStart(2, '0');
            return `(${mins}:${secs}) ${s.text}`;
        })
        .join('\n');

    return { fullText, segments: allSegments };
}

// ──────────────────────────────────────────────
// Cleanup: delete audio chunks + chunksDir
// ──────────────────────────────────────────────
async function cleanupChunks(chunksDir) {
    try {
        await fs.remove(chunksDir);
        console.log(`🧹 Cleaned up chunks dir: ${chunksDir}`);
    } catch (err) {
        console.warn(`⚠️  Could not clean up chunks dir: ${err.message}`);
    }
}

// ──────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────
async function main() {
    const inputAudio = process.argv[2];

    if (!inputAudio) {
        console.error('❌ Usage: node scripts/transcribeAudio.js <path-to-audio-file>');
        process.exit(1);
    }

    if (!await fs.pathExists(inputAudio)) {
        console.error(`❌ Audio file not found: ${inputAudio}`);
        process.exit(1);
    }

    const fileName = path.basename(inputAudio, path.extname(inputAudio));
    const outputDir = path.resolve(__dirname, '../transcription_output', fileName);
    const chunksDir = path.join(outputDir, 'chunks');

    await fs.ensureDir(outputDir);

    console.log('═══════════════════════════════════════');
    console.log('🎵 AUDIO TRANSCRIPTION PIPELINE');
    console.log('═══════════════════════════════════════');
    console.log(`📂 Input:  ${inputAudio}`);
    console.log(`📂 Output: ${outputDir}`);
    console.log('═══════════════════════════════════════\n');

    // Step 1: Chunk
    console.log('STEP 1: CHUNKING AUDIO');
    console.log('───────────────────────');
    const chunks = await chunkAudio(inputAudio, chunksDir);

    // Step 2: Transcribe
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

    await fs.writeFile(path.join(outputDir, 'transcript.txt'), fullText);
    await fs.writeJson(path.join(outputDir, 'transcript_segments.json'), segments, { spaces: 2 });
    console.log('✅ Merged transcript saved');

    // Step 4: Cleanup chunks (audio files + chunk JSONs)
    console.log('\nSTEP 4: CLEANUP');
    console.log('────────────────');
    await cleanupChunks(chunksDir);

    console.log('\n═══════════════════════════════════════');
    console.log('✅ TRANSCRIPTION COMPLETE');
    console.log('═══════════════════════════════════════');
    console.log(`📄 Full transcript:  ${path.join(outputDir, 'transcript.txt')}`);
    console.log(`📋 Segments JSON:    ${path.join(outputDir, 'transcript_segments.json')}`);
    console.log(`🔢 Total segments:   ${segments.length}`);
    console.log(`📦 Chunks processed: ${chunks.length} (deleted after merge)`);
    console.log('═══════════════════════════════════════\n');

    console.log('📝 TRANSCRIPT PREVIEW:');
    console.log('───────────────────────');
    console.log(fullText.slice(0, 500) + '...\n');
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});