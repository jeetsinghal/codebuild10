# TRUSTMESH v2 — Working Hackathon Prototype

AI × Blockchain credential verification demo.

## What works out of the box
- Web dashboard and navigation
- Credential upload (PDF/JPG/PNG)
- Deterministic offline AI demo mode
- SHA-256 fingerprinting
- Persistent verification history
- Cryptographic local proof chain
- Fraud Hunter
- Recruiter Agent
- Blockchain Proof page
- Optional real OpenAI analysis
- Optional real Sepolia anchoring

## Run on macOS / Linux
```bash
cd TRUSTMESH_V2
npm install
npm start
```
Open http://localhost:3000

## Windows
```bat
npm install
npm start
```
Open http://localhost:3000

## Enable real OpenAI
Copy `.env.example` to `.env` and add:
`OPENAI_API_KEY=...`

The app uses the OpenAI Responses API for file analysis when the key exists. Without a key, Demo AI remains fully functional.

## Enable real Sepolia
Deploy `contracts/CredentialAnchor.sol` to Sepolia and add:
- `SEPOLIA_RPC_URL`
- `BLOCKCHAIN_PRIVATE_KEY`
- `TRUSTMESH_CONTRACT_ADDRESS`

Without those variables the prototype uses its local cryptographic proof chain and clearly labels it as such.

## Demo flow
1. Dashboard → Verify Credential
2. Upload any PDF/image credential
3. Run Trust Agent
4. Inspect Trust Score + Fraud Hunter
5. Click Anchor Proof
6. Open Blockchain Proof
7. Open Recruiter Agent
8. Open History
