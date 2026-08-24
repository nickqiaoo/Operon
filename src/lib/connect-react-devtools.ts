import { connectToDevTools, initialize } from 'react-devtools-core';

type ReactDevToolsWindow = Window & {
  __OPERON_REACT_DEVTOOLS_CONNECTED__?: boolean;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
    sub?: unknown;
  };
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  const devtoolsWindow = window as ReactDevToolsWindow;

  if (!devtoolsWindow.__OPERON_REACT_DEVTOOLS_CONNECTED__) {
    try {
      const globalHook = devtoolsWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (globalHook && typeof globalHook.sub !== 'function') {
        Reflect.deleteProperty(devtoolsWindow, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
      }

      initialize();
      connectToDevTools({
        host: 'localhost',
        port: 8097,
        isAppActive: () => document.visibilityState !== 'hidden',
      });
      devtoolsWindow.__OPERON_REACT_DEVTOOLS_CONNECTED__ = true;
      console.log('React DevTools bridge connected on localhost:8097');
    } catch (error) {
      console.error('Failed to connect React DevTools bridge:', error);
    }
  }
}

export {};
