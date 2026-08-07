#include "opus_seek_decoder.h"
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

/* JS Range I/O — ASYNCIFY so libopusfile sync callbacks can await fetch. */

EM_ASYNC_JS(int, js_seek_io_read, (int sid, uint8_t *ptr, int nbytes), {
  const data = await Module.SeekIO.read(sid, nbytes);
  if (!data || data.length === 0) return 0;
  const n = Math.min(nbytes, data.length);
  HEAPU8.set(data.subarray(0, n), ptr);
  return n;
});

EM_ASYNC_JS(int, js_seek_io_seek, (int sid, double offset, int whence), {
  const ok = await Module.SeekIO.seek(sid, offset, whence);
  return ok ? 0 : -1;
});

EM_ASYNC_JS(int, js_seek_io_tell, (int sid), {
  return (await Module.SeekIO.tell(sid)) | 0;
});

static int cb_read(void *stream, unsigned char *ptr, int nbytes) {
  OpusSeekDecoder *dec = (OpusSeekDecoder *)stream;
  if (nbytes <= 0) return 0;
  return js_seek_io_read(dec->stream_id, ptr, nbytes);
}

static int cb_seek(void *stream, opus_int64 offset, int whence) {
  OpusSeekDecoder *dec = (OpusSeekDecoder *)stream;
  return js_seek_io_seek(dec->stream_id, (double)offset, whence);
}

static opus_int64 cb_tell(void *stream) {
  OpusSeekDecoder *dec = (OpusSeekDecoder *)stream;
  return (opus_int64)js_seek_io_tell(dec->stream_id);
}

OpusSeekDecoder *opus_seek_decoder_create(int stream_id) {
  OpusSeekDecoder *dec = (OpusSeekDecoder *)malloc(sizeof(OpusSeekDecoder));
  if (!dec) return NULL;
  memset(dec, 0, sizeof(*dec));
  dec->stream_id = stream_id;
  dec->cb.read = cb_read;
  dec->cb.seek = cb_seek;
  dec->cb.tell = cb_tell;
  dec->cb.close = NULL;
  return dec;
}

void opus_seek_decoder_free(OpusSeekDecoder *dec) {
  if (!dec) return;
  if (dec->of) {
    op_free(dec->of);
    dec->of = NULL;
  }
  free(dec);
}

int opus_seek_decoder_open(OpusSeekDecoder *dec) {
  if (!dec) return OP_EFAULT;
  if (dec->of) {
    op_free(dec->of);
    dec->of = NULL;
  }
  int err = 0;
  dec->of = op_open_callbacks(dec, &dec->cb, NULL, 0, &err);
  return err;
}

double opus_seek_decoder_pcm_total(OpusSeekDecoder *dec) {
  if (!dec || !dec->of) return (double)OP_EINVAL;
  return (double)op_pcm_total(dec->of, -1);
}

int opus_seek_decoder_pcm_seek(OpusSeekDecoder *dec, double pcm_offset) {
  if (!dec || !dec->of) return OP_EINVAL;
  return op_pcm_seek(dec->of, (ogg_int64_t)pcm_offset);
}

int opus_seek_decoder_read_stereo(OpusSeekDecoder *dec, float *pcm_out, int pcm_out_size) {
  if (!dec || !dec->of || !pcm_out || pcm_out_size <= 0) return 0;
  return op_read_float_stereo(dec->of, pcm_out, pcm_out_size);
}
