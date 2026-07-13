import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  localStorage.clear();
});
