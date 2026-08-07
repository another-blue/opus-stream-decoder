// Dont' use ES6 features like const, let, arrow functions. Emcc minification
// will fail. Used old-school JS.

Module['OpusStreamDecoder'] = OpusStreamDecoder;

// nodeJS only
if ('undefined' !== typeof global && exports) {
  module.exports.OpusStreamDecoder = OpusStreamDecoder;
  // uncomment this for performance testing
  // var {performance} = require('perf_hooks');
  // global.performance = performance;
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
  };

  Object.freeze(api);
  Object.defineProperty(OpusStreamDecoder.prototype, 'api', {value: api});
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
