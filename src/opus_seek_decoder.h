#ifndef OPUS_SEEK_DECODER_H
#define OPUS_SEEK_DECODER_H

#include <opusfile.h>
#include <stdint.h>

/**
 * Seekable Ogg Opus decoder backed by JS HTTP Range I/O (ASYNCIFY).
 * stream id is passed to Module.SeekIO.* so multiple instances can coexist.
 */
typedef struct {
  int stream_id;
  OggOpusFile *of;
  OpusFileCallbacks cb;
} OpusSeekDecoder;

OpusSeekDecoder *opus_seek_decoder_create(int stream_id);
void opus_seek_decoder_free(OpusSeekDecoder *dec);

/** Open via op_open_callbacks; returns 0 on success, opusfile err otherwise. */
int opus_seek_decoder_open(OpusSeekDecoder *dec);

/** Total PCM samples at 48 kHz as double (avoids i64/BigInt in JS). */
double opus_seek_decoder_pcm_total(OpusSeekDecoder *dec);

/** Seek to PCM sample offset (48 kHz). Returns 0 on success. */
int opus_seek_decoder_pcm_seek(OpusSeekDecoder *dec, double pcm_offset);

/**
 * Read interleaved stereo float PCM.
 * pcm_out_size is the interleaved float capacity (samples * channels).
 * Returns samples decoded per channel (same as op_read_float_stereo).
 */
int opus_seek_decoder_read_stereo(OpusSeekDecoder *dec, float *pcm_out, int pcm_out_size);

#endif
