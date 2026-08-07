/*
 * Seekable mid-file Range decode test (BLUE-376 / C1).
 *
 *   $ node dist/test-opus-seek-decoder.js OPUS_FILE
 *
 * Simulates HTTP Range via fetchRange over an in-memory file. Asserts:
 *  - mid-file decodeTimeRange produces PCM
 *  - no single request spans the entire file
 */
const args = process.argv;
const fs = require('fs');
const path = require('path');
const thisScriptFolder = args[1].match(/^.*\//)[0];
process.chdir(thisScriptFolder);

const { SeekableOpusDecoder } = require('./opus-stream-decoder.js');

const opusPath = args[2];
if (!opusPath) {
  console.error('Usage: node test-opus-seek-decoder.js OPUS_FILE');
  process.exit(2);
}

const fileAbs = opusPath.startsWith('/') ? opusPath : path.join(process.cwd(), '..', opusPath);
const fileBytes = fs.readFileSync(fileAbs.endsWith('.opus') && fs.existsSync(opusPath) ? opusPath : fileAbs);
// Prefer cwd-relative path from Makefile (tmp/...)
const buf = fs.existsSync(opusPath) ? fs.readFileSync(opusPath) : fileBytes;

async function main() {
  const requests = [];
  const fetchRange = async (start, endInclusive) => {
    if (start < 0 || endInclusive >= buf.length || endInclusive < start) {
      throw new Error(`bad range ${start}-${endInclusive} len=${buf.length}`);
    }
    const span = endInclusive - start + 1;
    if (span === buf.length) {
      throw new Error('fetchRange must not request the entire file in one Range');
    }
    requests.push({ start, end: endInclusive, span });
    return buf.subarray(start, endInclusive + 1);
  };

  const dec = new SeekableOpusDecoder();
  const { pcmTotal } = await dec.open({
    contentLength: buf.length,
    fetchRange,
  });
  console.log('open ok, pcmTotal=', pcmTotal, 'bytes=', buf.length);

  const durationSec = Number(pcmTotal) / 48000;
  const mid = durationSec * 0.5;
  const window = await dec.decodeTimeRange(mid, mid + 0.5);
  console.log(
    'mid window samples=',
    window.samplesDecoded,
    'originSec=',
    window.originSec,
    'rangeRequests=',
    window.requests.length,
  );

  if (window.samplesDecoded < 48000 * 0.3) {
    throw new Error('expected at least ~0.3s of PCM from mid window');
  }

  // Full-file single GET never allowed by fetchRange; also check max span
  const maxSpan = Math.max(...requests.map((r) => r.span), 0);
  console.log('total Range GETs=', requests.length, 'maxSpan=', maxSpan);
  if (maxSpan >= buf.length) {
    throw new Error('a Range request covered the entire file');
  }

  // Seek near start
  const head = await dec.decodeTimeRange(0, 0.25);
  console.log('head samples=', head.samplesDecoded);
  if (head.samplesDecoded < 1000) throw new Error('head window too short');

  // Corrupt / closed
  dec.free();
  try {
    await dec.decodeTimeRange(0, 1);
    throw new Error('expected error after free');
  } catch (e) {
    if (!/open/.test(String(e.message))) throw e;
    console.log('post-free error ok');
  }

  console.log('SEEK TEST PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
