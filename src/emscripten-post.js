// Dont' use ES6 features like const, let, arrow functions. Emcc minification
// will fail. Used old-school JS.

Module['OpusStreamDecoder'] = OpusStreamDecoder;
Module['SeekableOpusDecoder'] = SeekableOpusDecoder;

// nodeJS only
if ('undefined' !== typeof global && exports) {
  module.exports.OpusStreamDecoder = OpusStreamDecoder;
  module.exports.SeekableOpusDecoder = SeekableOpusDecoder;
}

// Decoder will pass decoded PCM data to onDecode
function OpusStreamDecodedAudio(left, right, samplesDecoded) {
  this.left = left;
  this.right = right;
  this.samplesDecoded = samplesDecoded;
  this.sampleRate = 48000;
}

// Pass options to create new decoder. Only currently supports options.onDecode
// onDecode will receive OpusStreamDecodedAudio object
function OpusStreamDecoder(options) {
  if ('function' !== typeof options.onDecode)
    throw Error('onDecode callback is required.');

  // set as read-only
  Object.defineProperty(this, 'onDecode', {value: options.onDecode});
}

function opusStreamDecoderBindApi() {
  // Prefer Module.* (Emscripten 3+); fall back to globals for older builds.
  var M = (typeof Module !== 'undefined') ? Module : null;
  var _cwrap = (M && M.cwrap) ? M.cwrap.bind(M) : cwrap;
  var _HEAPU8 = (M && M.HEAPU8) ? M.HEAPU8 : HEAPU8;
  var _HEAPF32 = (M && M.HEAPF32) ? M.HEAPF32 : HEAPF32;

  var api = {
    malloc: _cwrap('malloc', 'number', ['number']),
    free: _cwrap('free', null, ['number']),
    HEAPU8: _HEAPU8,
    HEAPF32: _HEAPF32,

    libopusVersion: _cwrap('opus_get_version_string', 'string', []),
    decoderVersion: _cwrap('opus_chunkdecoder_version', 'string', []),
    createDecoder: _cwrap('opus_chunkdecoder_create', 'number', []),
    freeDecoder: _cwrap('opus_chunkdecoder_free', null, ['number']),
    enqueue: _cwrap('opus_chunkdecoder_enqueue', 'number', ['number', 'number', 'number']),
    decode: _cwrap('opus_chunkdecoder_decode_float_stereo_deinterleaved', 'number', ['number', 'number', 'number', 'number', 'number']),

    // Seekable path (ASYNCIFY — these return Promises)
    createSeekDecoder: _cwrap('opus_seek_decoder_create', 'number', ['number']),
    freeSeekDecoder: _cwrap('opus_seek_decoder_free', null, ['number']),
    seekOpen: _cwrap('opus_seek_decoder_open', 'number', ['number'], {async: true}),
    seekPcmTotal: _cwrap('opus_seek_decoder_pcm_total', 'number', ['number'], {async: true}),
    seekPcmSeek: _cwrap('opus_seek_decoder_pcm_seek', 'number', ['number', 'number'], {async: true}),
    seekReadStereo: _cwrap('opus_seek_decoder_read_stereo', 'number', ['number', 'number', 'number'], {async: true}),
  };

  Object.freeze(api);
  Object.defineProperty(OpusStreamDecoder.prototype, 'api', {value: api});
  Object.defineProperty(SeekableOpusDecoder.prototype, 'api', {value: api});
  return api;
}

// Emscripten resolves when Wasm HEAP is ready.
// Modern Emscripten often skips addOnPreMain callbacks (no main / async wasm),
// so also hook onRuntimeInitialized and poll for HEAPU8.
OpusStreamDecoder.prototype.ready = new Promise(function(resolve, reject) {
  var settled = false;

  function done() {
    if (settled) return;
    settled = true;
    try {
      opusStreamDecoderBindApi();
      resolve();
    } catch (err) {
      reject(err);
    }
  }

  function heapReady() {
    try {
      if (typeof Module !== 'undefined' && Module.HEAPU8) return true;
      if (typeof HEAPU8 !== 'undefined') return true;
    } catch (_) {}
    return false;
  }

  function attempt() {
    if (heapReady()) done();
  }

  if (typeof addOnPreMain === 'function') {
    addOnPreMain(attempt);
  }

  var M = typeof Module !== 'undefined' ? Module : {};
  var prev = M['onRuntimeInitialized'];
  M['onRuntimeInitialized'] = function() {
    if (typeof prev === 'function') prev();
    attempt();
  };

  if (M.calledRun || heapReady()) {
    attempt();
    return;
  }

  var ticks = 0;
  var timer = setInterval(function() {
    attempt();
    if (settled || ++ticks > 500) clearInterval(timer);
    if (ticks > 500 && !settled) {
      reject(Error('OpusStreamDecoder: Wasm runtime failed to initialize'));
    }
  }, 10);
});

/*
    Decodes audio and calls onDecode with OpusStreamDecodedAudio object. Interleaved
    buffer is reused over multiple Wasm decode() calls because internal C Opus
    decoding library requires it, and a custom C function then deinterleaves
    it.  We're only concerned with returning left/right channels, but the
    interleaved buffer is reused for performance hopes.
 */
OpusStreamDecoder.prototype.decode = function(uint8array) {
  if (!(uint8array instanceof Uint8Array))
    throw Error('Data to decode must be Uint8Array');

  if (!this._decoderPointer) {
    this._decoderPointer = this.api.createDecoder();
  }

  var srcPointer, decodedInterleavedPtr, decodedInterleavedArry,
      decodedLeftPtr, decodedLeftArry,
      decodedRightPtr, decodedRightArry;

  try {
    // 120ms buffer recommended per http://opus-codec.org/docs/opusfile_api-0.7/group__stream__decoding.html
    var decodedPcmSize = 120*48*2; // 120ms @ 48 khz * 2 channels.

    // All decoded PCM data will go into these arrays.  Pass pointers to Wasm
    [decodedInterleavedPtr, decodedInterleavedArry] = this.createOutputArray(decodedPcmSize);
    [decodedLeftPtr, decodedLeftArry] = this.createOutputArray(decodedPcmSize/2);
    [decodedRightPtr, decodedRightArry] = this.createOutputArray(decodedPcmSize/2);

    // Enqueue/decode uint8array at 16k in intervals to prevent buffer overflow
    // Required for https://github.com/AnthumChris/opus-stream-decoder/commit/52c7347
    var sendMax = 16*1024, sendStart = 0, sendSize;
    var srcLen = uint8array.byteLength;

    // put uint8array 16k sends on Wasm HEAP and get pointer to it
    srcPointer = this.api.malloc(uint8array.BYTES_PER_ELEMENT * sendMax);

    while (sendStart < srcLen) {
      sendSize = Math.min(sendMax, srcLen-sendStart); // upper boundary for last iteration
      this.api.HEAPU8.set(uint8array.subarray(sendStart, sendStart+sendSize), srcPointer);
      sendStart += sendSize;

      // enqueue bytes to decode. Fail on error
      if (!this.api.enqueue(this._decoderPointer, srcPointer, sendSize))
        throw Error('Could not enqueue bytes for decoding.  You may also have invalid Ogg Opus file.');

      // // continue to decode until no more bytes are left to decode
      var samplesDecoded, totalSamplesDecoded = 0;
      // var decodeStart = performance.now();
      while (samplesDecoded = this.api.decode(
        this._decoderPointer,
        decodedInterleavedPtr,
        decodedPcmSize,
        decodedLeftPtr,
        decodedRightPtr
      )) {
        // performance audits show 960 samples (20ms) of data being decoded per call
        // console.log('decoded',(samplesDecoded/48000*1000).toFixed(2)+'ms in', (performance.now()-decodeStart).toFixed(2)+'ms');

        totalSamplesDecoded+=samplesDecoded;
        // return copies of decoded bytes because underlying buffers will be re-used
        this.onDecode(new OpusStreamDecodedAudio(
          decodedLeftArry.slice(0, samplesDecoded),
          decodedRightArry.slice(0, samplesDecoded),
          samplesDecoded
        ));

        // decodeStart = performance.now();
      }
    }
  } catch (e) {
    throw e;
  } finally {
    // free wasm memory
    this.api.free(srcPointer);
    this.api.free(decodedInterleavedPtr);
    this.api.free(decodedLeftPtr);
    this.api.free(decodedRightPtr);
  }
}

OpusStreamDecoder.prototype.free = function() {
  if (this._decoderPointer) {
    this.api.freeDecoder(this._decoderPointer);
  }
}

// creates Float32Array on Wasm heap and returns it and its pointer
// returns [pointer, array]
// free(pointer) must be done after using it.
// array values cannot be gauranteed since memory space may be reused
// call array.fill(0) if instantiation is required
// set as read-only
Object.defineProperty(OpusStreamDecoder.prototype, 'createOutputArray', {
  value: function(length) {
    var pointer = this.api.malloc(Float32Array.BYTES_PER_ELEMENT * length);
    var array = new Float32Array(this.api.HEAPF32.buffer, pointer, length);
    return [pointer, array];
  }
});

/* ========== SeekableOpusDecoder (HTTP Range + libopusfile seek) ========== */

var SEEK_SET = 0;
var SEEK_CUR = 1;
var SEEK_END = 2;
var OPUS_PREROLL_SAMPLES = 3840; // RFC 7845: 80 ms @ 48 kHz

Module.SeekIO = {
  nextId: 1,
  streams: {},
  register: function(opts) {
    var id = this.nextId++;
    this.streams[id] = {
      contentLength: opts.contentLength,
      position: 0,
      fetchRange: opts.fetchRange,
      requests: []
    };
    return id;
  },
  unregister: function(id) {
    delete this.streams[id];
  },
  read: async function(sid, nbytes) {
    var s = this.streams[sid];
    if (!s || nbytes <= 0) return new Uint8Array(0);
    if (s.position >= s.contentLength) return new Uint8Array(0);
    var start = s.position;
    var end = Math.min(s.contentLength - 1, start + nbytes - 1);
    s.requests.push({ start: start, end: end });
    var data = await s.fetchRange(start, end);
    if (!(data instanceof Uint8Array)) {
      data = new Uint8Array(data);
    }
    // Clamp to requested span length
    var want = end - start + 1;
    if (data.length > want) data = data.subarray(0, want);
    s.position = start + data.length;
    return data;
  },
  seek: async function(sid, offset, whence) {
    var s = this.streams[sid];
    if (!s) return false;
    var pos = s.position;
    if (whence === SEEK_SET) pos = offset;
    else if (whence === SEEK_CUR) pos = s.position + offset;
    else if (whence === SEEK_END) pos = s.contentLength + offset;
    else return false;
    if (pos < 0 || pos > s.contentLength) return false;
    s.position = pos;
    return true;
  },
  tell: async function(sid) {
    var s = this.streams[sid];
    return s ? s.position : 0;
  }
};

function SeekableOpusDecoder(options) {
  options = options || {};
  this.onDecode = typeof options.onDecode === 'function' ? options.onDecode : null;
  this._sid = null;
  this._ptr = 0;
  this._opened = false;
}

SeekableOpusDecoder.prototype.ready = OpusStreamDecoder.prototype.ready;

SeekableOpusDecoder.prototype.open = async function(opts) {
  if (!opts || typeof opts.contentLength !== 'number' || opts.contentLength <= 0) {
    throw Error('open requires contentLength > 0');
  }
  if (typeof opts.fetchRange !== 'function') {
    throw Error('open requires fetchRange(start, endInclusive) => Uint8Array');
  }
  await this.ready;
  this.free();
  this._sid = Module.SeekIO.register({
    contentLength: opts.contentLength,
    fetchRange: opts.fetchRange
  });
  this._ptr = this.api.createSeekDecoder(this._sid);
  if (!this._ptr) throw Error('opus_seek_decoder_create failed');
  var err = await this.api.seekOpen(this._ptr);
  if (err !== 0) {
    this.free();
    throw Error('opus_seek_decoder_open failed: ' + err);
  }
  this._opened = true;
  var pcmTotal = await this.api.seekPcmTotal(this._ptr);
  return {
    pcmTotal: typeof pcmTotal === 'bigint' ? Number(pcmTotal) : pcmTotal
  };
};

/**
 * Decode [startSec, endSec] with RFC 7845 pre-roll.
 * Returns { samplesDecoded, sampleRate, left, right, originSec, requests }.
 */
SeekableOpusDecoder.prototype.decodeTimeRange = async function(startSec, endSec) {
  if (!this._opened) throw Error('call open() before decodeTimeRange');
  if (!(endSec > startSec)) throw Error('endSec must be > startSec');

  var startPcm = Math.max(0, Math.floor(startSec * 48000) - OPUS_PREROLL_SAMPLES);
  var endPcm = Math.ceil(endSec * 48000);
  var discard = Math.floor(startSec * 48000) - startPcm;

  var seekErr = await this.api.seekPcmSeek(this._ptr, startPcm);
  if (seekErr !== 0) throw Error('op_pcm_seek failed: ' + seekErr);

  var capacity = 120 * 48 * 2; // interleaved floats for 120ms
  var pcmPtr = this.api.malloc(Float32Array.BYTES_PER_ELEMENT * capacity);
  var leftChunks = [];
  var rightChunks = [];
  var totalKept = 0;
  var pcmCursor = startPcm;

  try {
    while (pcmCursor < endPcm) {
      var n = await this.api.seekReadStereo(this._ptr, pcmPtr, capacity);
      if (n <= 0) break;
      var interleaved = new Float32Array(this.api.HEAPF32.buffer, pcmPtr, n * 2);
      var left = new Float32Array(n);
      var right = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        left[i] = interleaved[i * 2];
        right[i] = interleaved[i * 2 + 1];
      }

      var keepFrom = 0;
      if (discard > 0) {
        keepFrom = Math.min(discard, n);
        discard -= keepFrom;
      }
      if (keepFrom < n) {
        var sliceL = left.subarray(keepFrom);
        var sliceR = right.subarray(keepFrom);
        leftChunks.push(sliceL.slice(0));
        rightChunks.push(sliceR.slice(0));
        totalKept += sliceL.length;
        if (this.onDecode) {
          this.onDecode(new OpusStreamDecodedAudio(sliceL.slice(0), sliceR.slice(0), sliceL.length));
        }
      }
      pcmCursor += n;
      if (pcmCursor - startPcm > (endPcm - startPcm) + 4800) break; // safety
    }
  } finally {
    this.api.free(pcmPtr);
  }

  function concat(chunks, total) {
    var out = new Float32Array(total);
    var o = 0;
    for (var c = 0; c < chunks.length; c++) {
      out.set(chunks[c], o);
      o += chunks[c].length;
    }
    return out;
  }

  var sid = this._sid;
  return {
    samplesDecoded: totalKept,
    sampleRate: 48000,
    left: concat(leftChunks, totalKept),
    right: concat(rightChunks, totalKept),
    originSec: startSec,
    requests: Module.SeekIO.streams[sid] ? Module.SeekIO.streams[sid].requests.slice() : []
  };
};

SeekableOpusDecoder.prototype.debugRequests = function() {
  if (!this._sid || !Module.SeekIO.streams[this._sid]) return [];
  return Module.SeekIO.streams[this._sid].requests.slice();
};

SeekableOpusDecoder.prototype.free = function() {
  if (this._ptr) {
    this.api.freeSeekDecoder(this._ptr);
    this._ptr = 0;
  }
  if (this._sid) {
    Module.SeekIO.unregister(this._sid);
    this._sid = null;
  }
  this._opened = false;
};
