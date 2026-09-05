import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Vercel filesystem is read-only except for /tmp.
const isVercel = !!process.env.VERCEL;
const dataDir = isVercel
    ? path.join('/tmp', 'trustmesh-data')
    : path.join(process.cwd(), 'data');

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'trustmesh.json');

const empty = {
    verifications: [],
    anchors: []
};

function read() {
    try {
        return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch {
        return structuredClone(empty);
    }
}

function write(x) {
    fs.writeFileSync(dbPath, JSON.stringify(x, null, 2));
}

function sha256(b) {
    return crypto.createHash('sha256').update(b).digest('hex');
}

function clamp(n) {
    return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

function demo(file) {
    const h = sha256(file.buffer);
    const n = parseInt(h.slice(0, 4), 16);
    const score = clamp(70 + (n % 29));
    const risk = 100 - score;

    return {
        mode: 'DEMO AI',
        trustScore: score,
        risk,
        verdict:
            score >= 85
                ? 'VERIFIED'
                : score >= 65
                    ? 'NEEDS REVIEW'
                    : 'HIGH RISK',
        checks: {
            issuer: score >= 75,
            identity: score >= 70,
            integrity: true
        },
        summary:
            'Deterministic offline analysis for hackathon demonstration. It does not prove issuer authenticity; external verification is still required.',
        issuer: 'Demo Issuer',
        credentialId: 'TM-' + h.slice(0, 10).toUpperCase(),
        skills: ['Python', 'AI/ML', 'Web3'],
        signals:
            score >= 85
                ? [
                    'No obvious structural anomaly in demo scan.',
                    'Cryptographic fingerprint generated.'
                ]
                : [
                    'Credential requires manual issuer verification.',
                    'Cryptographic fingerprint generated.'
                ],
        hash: h,
        fileName: file.originalname
    };
}

async function realAI(file) {
    if (!process.env.OPENAI_API_KEY) {
        return demo(file);
    }

    const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const base64 = file.buffer.toString('base64');

    const prompt = `You are TRUSTMESH Trust Agent. Analyze this credential conservatively. Do not claim authenticity solely from appearance. Return ONLY valid JSON with keys: trustScore(0-100), risk(0-100), verdict(VERIFIED|NEEDS REVIEW|HIGH RISK), checks({issuer,identity,integrity}), summary, issuer, credentialId, skills(array), signals(array). Mention uncertainty when issuer evidence is unavailable.`;

    const r = await client.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-5.1',
        input: [
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: prompt
                    },
                    {
                        type: 'input_file',
                        filename: file.originalname,
                        file_data: base64
                    }
                ]
            }
        ]
    });

    let x;

    try {
        x = JSON.parse(r.output_text);
    } catch {
        x = {
            trustScore: 60,
            risk: 40,
            verdict: 'NEEDS REVIEW',
            checks: {
                issuer: false,
                identity: true,
                integrity: true
            },
            summary: r.output_text.slice(0, 1200),
            issuer: 'Unknown',
            credentialId: 'Unknown',
            skills: [],
            signals: [
                'AI returned non-JSON output; manual review required.'
            ]
        };
    }

    return {
        ...x,
        mode: 'REAL AI',
        trustScore: clamp(x.trustScore),
        risk: clamp(x.risk),
        hash: sha256(file.buffer),
        fileName: file.originalname
    };
}

async function sepoliaAnchor(hash, credentialId) {
    if (
        !process.env.SEPOLIA_RPC_URL ||
        !process.env.BLOCKCHAIN_PRIVATE_KEY ||
        !process.env.TRUSTMESH_CONTRACT_ADDRESS
    ) {
        return null;
    }

    const abi = [
        'function anchor(bytes32 documentHash,string credentialId)',
        'function verify(bytes32 documentHash) view returns (bool,uint64,address,string)'
    ];

    const provider = new ethers.JsonRpcProvider(
        process.env.SEPOLIA_RPC_URL
    );

    const wallet = new ethers.Wallet(
        process.env.BLOCKCHAIN_PRIVATE_KEY,
        provider
    );

    const c = new ethers.Contract(
        process.env.TRUSTMESH_CONTRACT_ADDRESS,
        abi,
        wallet
    );

    const tx = await c.anchor('0x' + hash, credentialId);
    const receipt = await tx.wait();

    return {
        network: 'Sepolia',
        txHash: receipt.hash,
        explorer: `https://sepolia.etherscan.io/tx/${receipt.hash}`,
        status: 'ANCHORED'
    };
}

app.use(express.json());
app.use(express.static('public'));

app.get('/api/status', (req, res) => {
    const real = !!process.env.OPENAI_API_KEY;

    const chain = !!(
        process.env.SEPOLIA_RPC_URL &&
        process.env.BLOCKCHAIN_PRIVATE_KEY &&
        process.env.TRUSTMESH_CONTRACT_ADDRESS
    );

    res.json({
        ok: true,
        ai: real ? 'REAL AI' : 'DEMO AI',
        blockchain: chain ? 'SEPOLIA' : 'LOCAL PROOF CHAIN',
        contractConfigured: !!process.env.TRUSTMESH_CONTRACT_ADDRESS
    });
});

app.get('/api/history', (req, res) => {
    res.json(read().verifications.slice(-50).reverse());
});

app.get('/api/ledger', (req, res) => {
    res.json(read().anchors.slice(-50).reverse());
});

app.post(
    '/api/verify',
    upload.single('credential'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    error: 'Upload a PDF, JPG or PNG credential.'
                });
            }

            const r = process.env.OPENAI_API_KEY
                ? await realAI(req.file)
                : demo(req.file);

            const db = read();

            const id = crypto.randomUUID();

            const record = {
                id,
                createdAt: new Date().toISOString(),
                ...r
            };

            db.verifications.push(record);
            write(db);

            res.json(record);
        } catch (e) {
            console.error(e);

            res.status(500).json({
                error: e.message || 'Verification failed'
            });
        }
    }
);

app.post('/api/anchor', async (req, res) => {
    try {
        const {
            hash,
            credentialId = 'UNKNOWN'
        } = req.body || {};

        if (!/^[a-f0-9]{64}$/i.test(hash || '')) {
            return res.status(400).json({
                error: 'Invalid SHA-256 hash'
            });
        }

        const db = read();

        const old = db.anchors.find(
            x => x.hash.toLowerCase() === hash.toLowerCase()
        );

        if (old) {
            return res.json(old);
        }

        let proof = await sepoliaAnchor(
            hash,
            credentialId
        );

        if (!proof) {
            const prev =
                db.anchors.at(-1)?.blockHash || 'GENESIS';

            const timestamp = new Date().toISOString();

            const blockHash = sha256(
                Buffer.from(
                    prev +
                    hash +
                    timestamp +
                    credentialId
                )
            );

            proof = {
                network: 'TRUSTMESH LOCAL PROOF CHAIN',
                blockNumber: db.anchors.length + 1,
                hash,
                credentialId,
                timestamp,
                previousBlockHash: prev,
                blockHash,
                status: 'ANCHORED'
            };
        } else {
            proof = {
                ...proof,
                hash,
                credentialId,
                timestamp: new Date().toISOString()
            };
        }

        db.anchors.push(proof);
        write(db);

        res.json(proof);
    } catch (e) {
        console.error(e);

        res.status(500).json({
            error: e.message || 'Anchoring failed'
        });
    }
});

app.get('*', (req, res) => {
    res.sendFile(
        path.join(
            process.cwd(),
            'public',
            'index.html'
        )
    );
});

app.listen(port, () => {
    console.log(`
TRUSTMESH v2 running: http://localhost:${port}
AI: ${process.env.OPENAI_API_KEY ? 'REAL' : 'DEMO'} | Blockchain: ${process.env.SEPOLIA_RPC_URL
            ? 'SEPOLIA'
            : 'LOCAL PROOF CHAIN'
        }
`);
});