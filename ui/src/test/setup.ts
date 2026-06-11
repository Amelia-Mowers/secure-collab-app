import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers)

// Cleanup after each test case
afterEach(() => {
  cleanup()
})

// jsdom does not implement matchMedia – polyfill it so useTheme doesn't crash
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// NOTE: We do NOT globally mock the WASM module here so that
// workspace.integration.test.ts can import and use the real WasmWorkspace.
// Files that render the full <App> (e.g. App.test.tsx) should mock
// @/wasm/generated/app_core.js locally using vi.mock() at the file level.
