import './globals';
import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { setNetworkId, NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import App from './App.js';
import * as pino from 'pino';

// Default to preprod for Midnight Network
const networkId = (import.meta.env.VITE_NETWORK_ID || 'preprod') as NetworkId;
setNetworkId(networkId);

// Initialize Pino Logger
export const logger = pino.pino({
  level: (import.meta.env.VITE_LOGGING_LEVEL || 'info') as string,
});

logger.info(`Booting Private Journal dApp. Network: ${networkId}`);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
