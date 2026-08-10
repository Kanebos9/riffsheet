/**
 * Bridge resolution.
 *
 * Two hosts, one interface: the JUCE shell (detected by `window.__JUCE__`) and the browser
 * mock used by development/tests. Nothing else in webcore may reach for `window.*`.
 */

import type { NativeBridge } from './types';
import { createMockBridge } from './mock';
import { createJuceBridge, isJuceHost } from './juce';

export * from './types';
export { importDroppedFile as importDroppedFileNative, isJuceHost } from './juce';

let cached: NativeBridge | null = null;
let usingMock = false;

export function getBridge(): NativeBridge {
  if (cached) return cached;

  if (isJuceHost()) {
    cached = createJuceBridge();
    usingMock = false;
  } else {
    cached = createMockBridge();
    usingMock = true;
  }
  return cached;
}

export function isMockBridge(): boolean {
  getBridge();
  return usingMock;
}
