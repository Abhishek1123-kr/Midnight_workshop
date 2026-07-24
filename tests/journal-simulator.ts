import {
  type CircuitContext,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
} from "../managed/journal/contract/index.js";
import { WitnessContext } from "@midnight-ntwrk/compact-runtime";

export type JournalPrivateState = {
  readonly secretKey: Uint8Array;
  readonly entryHashToCommit: Uint8Array;
};

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, JournalPrivateState>): [
    JournalPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],

  getPrivateEntryHash: ({
    privateState,
  }: WitnessContext<Ledger, JournalPrivateState>): [
    JournalPrivateState,
    Uint8Array,
  ] => [privateState, privateState.entryHashToCommit],
};

/**
 * Simulator to execute and test the Journal contract logic in vitest
 */
export class JournalSimulator {
  readonly contract: Contract<JournalPrivateState>;
  circuitContext: CircuitContext<JournalPrivateState>;

  constructor(secretKey: Uint8Array) {
    this.contract = new Contract<JournalPrivateState>(witnesses);
    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState,
    } = this.contract.initialState(
      createConstructorContext({ secretKey, entryHashToCommit: new Uint8Array(32) }, "0".repeat(64)),
    );
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      costModel: CostModel.initialCostModel(),
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
    };
  }

  public switchUser(secretKey: Uint8Array) {
    this.circuitContext.currentPrivateState = {
      ...this.circuitContext.currentPrivateState,
      secretKey,
    };
  }

  public setEntryHashToCommit(hash: Uint8Array) {
    this.circuitContext.currentPrivateState = {
      ...this.circuitContext.currentPrivateState,
      entryHashToCommit: hash,
    };
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public getPrivateState(): JournalPrivateState {
    return this.circuitContext.currentPrivateState;
  }

  public initialize(): Ledger {
    this.circuitContext = this.contract.impureCircuits.initialize(
      this.circuitContext,
    ).context;
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public addEntry(entryHash: Uint8Array): Ledger {
    this.setEntryHashToCommit(entryHash);
    this.circuitContext = this.contract.impureCircuits.addEntry(
      this.circuitContext,
    ).context;
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public publicKey(): Uint8Array {
    return this.contract.circuits.publicKey(
      this.circuitContext,
      this.getPrivateState().secretKey,
    ).result;
  }
}
