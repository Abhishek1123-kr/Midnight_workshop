import { JournalSimulator } from "./journal-simulator.js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { describe, it, expect } from "vitest";
import crypto from "crypto";

setNetworkId("undeployed");

const randomBytes = (length: number): Uint8Array => {
  return new Uint8Array(crypto.randomBytes(length));
};

describe("Journal smart contract", () => {
  // Test 1: Verification of Initial State & Setup
  it("properly initializes ledger state to default uninitialized values", () => {
    const secretKey = randomBytes(32);
    const simulator = new JournalSimulator(secretKey);
    const initialLedger = simulator.getLedger();

    expect(initialLedger.entryCount).toEqual(0n);
    expect(initialLedger.lastEntryHash).toEqual(new Uint8Array(32));
    expect(initialLedger.owner).toEqual(new Uint8Array(32));

    const initialPrivateState = simulator.getPrivateState();
    expect(initialPrivateState.secretKey).toEqual(secretKey);
  });

  // Test 2: Verification of Circuit logic and State Transitions
  it("allows owner initialization and correctly updates on-chain owner key", () => {
    const secretKey = randomBytes(32);
    const simulator = new JournalSimulator(secretKey);

    // Call initialize circuit
    simulator.initialize();

    const ledgerState = simulator.getLedger();
    const expectedPublicKey = simulator.publicKey();

    expect(ledgerState.owner).toEqual(expectedPublicKey);
    expect(ledgerState.entryCount).toEqual(0n);
    expect(ledgerState.lastEntryHash).toEqual(new Uint8Array(32));
  });

  // Test 3: Verification of State Transition (increments and hash updates)
  it("allows adding entries, increments entryCount, and updates lastEntryHash", () => {
    const secretKey = randomBytes(32);
    const simulator = new JournalSimulator(secretKey);
    simulator.initialize();

    const entryHash1 = randomBytes(32);
    simulator.addEntry(entryHash1);

    let ledgerState = simulator.getLedger();
    expect(ledgerState.entryCount).toEqual(1n);
    expect(ledgerState.lastEntryHash).toEqual(entryHash1);

    const entryHash2 = randomBytes(32);
    simulator.addEntry(entryHash2);

    ledgerState = simulator.getLedger();
    expect(ledgerState.entryCount).toEqual(2n);
    expect(ledgerState.lastEntryHash).toEqual(entryHash2);
  });

  // Test 4: Verification of Privacy (private inputs are never exposed)
  it("keeps private secretKey off-chain and only exposes committed public states", () => {
    const secretKey = randomBytes(32);
    const simulator = new JournalSimulator(secretKey);
    simulator.initialize();

    const entryHash = randomBytes(32);
    simulator.addEntry(entryHash);

    const ledgerState = simulator.getLedger();

    // Check that secretKey is NOT present anywhere on the public ledger
    expect(ledgerState.owner).not.toEqual(secretKey);
    expect(ledgerState.lastEntryHash).not.toEqual(secretKey);
    
    // Ensure private state is preserved off-chain and has not been cleared or mutated in ledger
    const privateState = simulator.getPrivateState();
    expect(privateState.secretKey).toEqual(secretKey);
  });

  // Test 5: Circuit logic enforcement (unauthorized user cannot write)
  it("prevents non-owners from writing entries to the journal", () => {
    const ownerSecretKey = randomBytes(32);
    const simulator = new JournalSimulator(ownerSecretKey);
    simulator.initialize();

    // Switch to an attacker's key
    const attackerSecretKey = randomBytes(32);
    simulator.switchUser(attackerSecretKey);

    const entryHash = randomBytes(32);
    expect(() => simulator.addEntry(entryHash)).toThrow(
      "failed assert: Caller is not the authorized owner of this journal"
    );
  });
});
