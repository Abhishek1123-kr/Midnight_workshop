# Midnight Private Journal
> A privacy-preserving decentralized journal built on the Midnight Network using Zero-Knowledge proofs.

## Contract Address
| Network  | Address                          |
|----------|-----------------------------------|
| Preprod  | [PASTE ADDRESS AFTER DEPLOY]     |

*(This section is MANDATORY. Leave placeholder until I give you the address.)*

## What This Does
The Midnight Private Journal enables users to write and record private journal entries. Instead of storing the actual journal text on the public blockchain, the application hashes the entry text off-chain privately and commits only the cryptographic hash to the ledger. This secures your thoughts privately while providing a public, tamper-proof proof that a specific entry was logged at a given state.

## Privacy Model
- **What is PUBLIC (on-chain, visible to anyone):**
  - **Owner Public Key:** The public key of the wallet authorized to write to this journal.
  - **Entry Count:** A public counter showing how many entries have been logged in the journal.
  - **Last Entry Hash:** The 32-byte cryptographic hash of the most recently written journal entry, acting as a verification commitment.
- **What is PRIVATE (private witness, never on-chain):**
  - **Owner Secret Key:** The secret key used to authorize transactions and prove ownership.
  - **Journal Entry Text:** The actual written text content of the journal entries.
  - **Private Entry Hash:** The raw input to the zero-knowledge circuit that is disclosed to the ledger state.
- **What the user PROVES without revealing:**
  - **Ownership:** That they hold the secret key corresponding to the registered public owner key.
  - **Commitment Authenticity:** That they generated the new entry commitment hash in compliance with the private witness inputs without leaking the secret key or the entry text itself.

## Tech Stack
- Midnight network, Compact language, Node.js v22, Docker

## Prerequisites
1. **Node.js:** version >= 24.11.1 (recommended) or v22.
2. **Docker:** Required for running the Midnight proof server.
3. **WSL (Windows Subsystem for Linux):** Required if running on Windows to execute the Compact compiler toolchain binary.
4. **Midnight Lace Wallet:** Installed as a browser extension.

## Setup

1. **Clone the project & Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start the Proof Server:**
   Ensure Docker is running and execute:
   ```bash
   docker run -d --name proof-server -p 6300:6300 midnightnetwork/proof-server
   ```

3. **Compile the Smart Contract:**
   ```bash
   npm run compact
   ```

4. **Launch the Frontend Locally:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

## Run Tests
Run the unit test suite with:
```bash
npm run test
```

## Initial Idea
[LEAVE PLACEHOLDER — I will fill this in manually]

## Screenshots
[LEAVE PLACEHOLDER — I will add compile output and contract address screenshots]
