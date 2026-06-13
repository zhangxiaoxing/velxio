/**
 * cyw43-sdpcm-align.test.ts
 *
 * Regression test for the gSPI word-alignment bug that silently dropped
 * DNS/TCP replies on the emulated Pico W.
 *
 * The CYW43439 F2 (radio frame) channel is word-oriented: the chip always
 * drives frames padded up to a 4-byte boundary and the host reads that
 * word-aligned length, byte-swapping every 32-bit word on the way in. If the
 * emulator emits an SDPCM frame whose backing buffer length is NOT a multiple
 * of 4, the host's symmetric per-word swap mangles the final partial word —
 * corrupting the last 1-3 bytes of the Ethernet frame.
 *
 * That went unnoticed for DHCP/ARP (UDP checksum 0 -> lwIP skips the check,
 * and the damage lands in trailing option padding) but quietly killed every
 * DNS answer and TCP segment (real checksum -> lwIP discards the frame ->
 * getaddrinfo()/connect() retry forever). `encodeSdpcm` now pads the buffer to
 * a word boundary while keeping the `size` header at the true length.
 */

import { describe, it, expect } from 'vitest';
import { encodeSdpcm, decodeSdpcm, SDPCM_HEADER_LEN } from '../simulation/cyw43/sdpcm';
import { SdpcmChannel } from '../simulation/cyw43/constants';

describe('SDPCM word alignment', () => {
  // Payload lengths that drive every total-length residue mod 4 once the
  // 12-byte header is added (12 is itself a multiple of 4).
  for (const payloadLen of [1, 2, 3, 4, 113, 125, 129, 314]) {
    it(`pads a ${payloadLen}-byte payload to a 4-byte boundary`, () => {
      const payload = new Uint8Array(payloadLen);
      for (let i = 0; i < payloadLen; i++) payload[i] = (i * 7 + 1) & 0xff;
      const frame = encodeSdpcm({ channel: SdpcmChannel.DATA, sequence: 5, payload });

      // The backing buffer the chip drives MUST be word-aligned.
      expect(frame.length % 4).toBe(0);

      // The `size` header stays the TRUE (unpadded) length so the driver
      // parses exactly the real frame and ignores the pad bytes.
      const trueSize = SDPCM_HEADER_LEN + payloadLen;
      const size = frame[0] | (frame[1] << 8);
      expect(size).toBe(trueSize);
      expect(frame[2] | (frame[3] << 8)).toBe(~trueSize & 0xffff);

      // decode recovers the exact payload, last byte intact.
      const decoded = decodeSdpcm(frame);
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
    });
  }

  it('survives a full per-word byte-swap round-trip with the last byte intact', () => {
    // The real DNS reply payload length the bug bit on: 4-byte BDC + 125-byte
    // Ethernet -> total 141, residue 1 mod 4. The last byte (0xf3, tail of the
    // second A-record IP) used to be lost.
    const payload = new Uint8Array(129);
    payload[128] = 0xf3;
    const frame = encodeSdpcm({ channel: SdpcmChannel.DATA, sequence: 0x2d, payload });
    expect(frame.length).toBe(144); // 141 padded up to 144

    // Model the gSPI path: the chip byte-swaps every 32-bit word, the host
    // byte-swaps them back. With a word-aligned buffer this is lossless.
    const swap = (b: Uint8Array) => {
      const out = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i += 4) {
        out[i] = b[i + 3]; out[i + 1] = b[i + 2]; out[i + 2] = b[i + 1]; out[i + 3] = b[i];
      }
      return out;
    };
    const roundTripped = swap(swap(frame));
    const decoded = decodeSdpcm(roundTripped);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload[128]).toBe(0xf3);
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
  });
});
