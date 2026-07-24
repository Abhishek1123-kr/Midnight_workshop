declare module '@midnight-ntwrk/midnight-js-network-id' {
  export type NetworkId = string;
  export const setNetworkId: (id: NetworkId) => void;
  export const getNetworkId: () => NetworkId;
}
