#!/usr/bin/env node
/**
 * Pre-download fallback models so the first 429 doesn't stall on a download.
 * Run inside Docker:   docker-compose exec clara node scripts/downloadModels.js
 * Run locally:         node scripts/downloadModels.js
 */

import 'dotenv/config';
import { ensureModels } from '../clients/local_fallback.js';

console.log('═══════════════════════════════════════');
console.log('📦 DOWNLOADING FALLBACK MODELS');
console.log('═══════════════════════════════════════\n');

try {
    await ensureModels();
    console.log('\n═══════════════════════════════════════');
    console.log('✅ All models cached. Fallback ready.');
    console.log('═══════════════════════════════════════');
} catch (err) {
    console.error('\n❌ Download failed:', err.message);
    process.exit(1);
}
