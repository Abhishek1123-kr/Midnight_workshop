import { Buffer } from 'buffer';

// Map `MODE` to `process.env.NODE_ENV` for third-party libraries that check it in the browser
// @ts-expect-error - support libraries that expect process.env
globalThis.process = {
  env: {
    NODE_ENV: import.meta.env.MODE,
  },
};

// Make Buffer available globally
globalThis.Buffer = Buffer;
