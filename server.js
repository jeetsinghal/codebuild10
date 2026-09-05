import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

/*
 * Vercel:
 * /var/task is read-only.
 * /tmp is writable but temporary.
 *
 * Local:
 * ./data is used normally.
 */
const dataDir = process.env.VERCEL
  ? '/tmp/trustmesh-data'
  : path.join(__dirname, 'data');

fs.mkdirSync(dataDir, {
  recursive: true
});

const dbPath = path.join(dataDir, 'trustmesh.json');

const emptyDB = {
  verifications: [],
  anchors: []
};

function readDB() {
  try {
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(
        dbPath,
        JSON.stringify(emptyDB, null, 2)
      );
    }

    const data = fs.readFileSync(dbPath, 'utf8');

    if (!data.trim()) {
      return {
        verifications: [],
        anchors: []
      };
    }

    const parsed = JSON.parse(data);

    return {
      verifications: Array.isArray(parsed.verifications)
        ? parsed.verifications
        : [],
      anchors: Array.isArray(parsed.anchors)
        ? parsed.anchors
        : []
    };
  } catch (error) {
    console.error('Database read error:', error);

    return {
      verifications: [],
      anchors: []
    };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(
      dbPath,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error('Database write error:', error);

    throw new Error(
      'Unable to save application data.'
    );
  }
}

function sha256(buffer) {
  return crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');
}

function clamp(value) {
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(Number(value) || 0)
    )
  );
}

/* ---------------- DEMO AI ---------------- */

function demoAnalysis(file) {
  const hash = sha256(file.buffer);
  const number = parseInt(hash.slice(0, 4), 16);

  const trustScore = clamp(
    70 + (number % 29)
  );

  const risk = 100 - trustScore;

  let verdict;

  if (trustScore >= 85) {
    verdict = 'VERIFIED';
  } else if (trustScore >= 65) {
    verdict = 'NEEDS REVIEW';
  } else {
    verdict = 'HIGH RISK';
  }

  return {
    mode: 'DEMO AI',
    trustScore,
    risk,
    verdict,

    checks: {
      issuer: trustScore >= 75,
      identity: trustScore >= 70,
      integrity: true
    },

    summary:
      'Deterministic offline analysis for hackathon demonstration. This result does not independently prove issuer authenticity.',

    issuer: 'Demo Issuer',

    credentialId:
      'TM-' +
      hash
        .slice(0, 10)
        .toUpperCase(),

    skills: [
      'Python',
      'AI/ML',
      'Web3'
    ],

    signals:
      trustScore >= 85
        ? [
            'No obvious structural anomaly detected in demo scan.',
            'Cryptographic fingerprint generated.'
          ]
        : [
            'Credential requires manual issuer verification.',
            'Cryptographic fingerprint generated.'
          ],

    hash,

    fileName: file.originalname
  };
}

/* ---------------- REAL AI ---------------- */

async function realAIAnalysis(file) {
  if (!process.env.OPENAI_API_KEY) {
    return demoAnalysis(file);
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const base64 =
    file.buffer.toString('base64');

  const mimeType =
    file.mimetype ||
    'application/octet-stream';

  const prompt = `
You are the TRUSTMESH Trust Agent.

Analyze the supplied credential conservatively.

Do not claim that a credential is authentic merely because it looks legitimate.

Return ONLY valid JSON.

Required structure:

{
  "trustScore": number,
  "risk": number,
  "verdict": "VERIFIED" | "NEEDS REVIEW" | "HIGH RISK",
  "checks": {
    "issuer": boolean,
    "identity": boolean,
    "integrity": boolean
  },
  "summary": string,
  "issuer": string,
  "credentialId": string,
  "skills": string[],
  "signals": string[]
}

If issuer authenticity cannot be independently established, clearly mention that limitation.
`;

  try {
    const response =
      await client.responses.create({
        model:
          process.env.OPENAI_MODEL ||
          'gpt-5.1',

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
                file_data:
                  `data:${mimeType};base64,${base64}`
              }
            ]
          }
        ]
      });

    let result;

    try {
      result = JSON.parse(
        response.output_text
      );
    } catch {
      result = {
        trustScore: 60,
        risk: 40,
        verdict: 'NEEDS REVIEW',

        checks: {
          issuer: false,
          identity: true,
          integrity: true
        },

        summary:
          response.output_text ||
          'AI analysis completed but returned an unexpected format.',

        issuer: 'Unknown',
        credentialId: 'Unknown',
        skills: [],

        signals: [
          'AI response could not be parsed into the expected structure.',
          'Manual review required.'
        ]
      };
    }

    return {
      ...result,

      mode: 'REAL AI',

      trustScore:
        clamp(result.trustScore),

      risk:
        clamp(result.risk),

      hash:
        sha256(file.buffer),

      fileName:
        file.originalname
    };
  } catch (error) {
    console.error(
      'OpenAI error:',
      error
    );

    /*
     * Do not crash the whole application
     * if the external AI provider fails.
     *
     * Fall back to demo mode.
     */
    return {
      ...demoAnalysis(file),

      mode: 'DEMO AI',

      signals: [
        'Real AI service was unavailable.',
        'Fallback demo analysis was used.',
        'Cryptographic fingerprint generated.'
      ]
    };
  }
}

/* ---------------- SEPOLIA ---------------- */

async function sepoliaAnchor(
  hash,
  credentialId
) {
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

  const provider =
    new ethers.JsonRpcProvider(
      process.env.SEPOLIA_RPC_URL
    );

  const wallet =
    new ethers.Wallet(
      process.env.BLOCKCHAIN_PRIVATE_KEY,
      provider
    );

  const contract =
    new ethers.Contract(
      process.env.TRUSTMESH_CONTRACT_ADDRESS,
      abi,
      wallet
    );

  const transaction =
    await contract.anchor(
      '0x' + hash,
      credentialId
    );

  const receipt =
    await transaction.wait();

  return {
    network: 'Sepolia',

    txHash:
      receipt.hash,

    explorer:
      `https://sepolia.etherscan.io/tx/${receipt.hash}`,

    status: 'ANCHORED'
  };
}

/* ---------------- MIDDLEWARE ---------------- */

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

/*
 * Serve frontend when a public directory exists.
 */
const publicDir =
  path.join(__dirname, 'public');

if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir)
  );
}

/* ---------------- STATUS ---------------- */

app.get(
  '/api/status',
  (req, res) => {
    const realAI =
      !!process.env.OPENAI_API_KEY;

    const sepolia =
      !!(
        process.env.SEPOLIA_RPC_URL &&
        process.env.BLOCKCHAIN_PRIVATE_KEY &&
        process.env.TRUSTMESH_CONTRACT_ADDRESS
      );

    res.json({
      ok: true,

      ai:
        realAI
          ? 'REAL AI'
          : 'DEMO AI',

      blockchain:
        sepolia
          ? 'SEPOLIA'
          : 'LOCAL PROOF CHAIN',

      contractConfigured:
        !!process.env.TRUSTMESH_CONTRACT_ADDRESS
    });
  }
);

/* ---------------- HISTORY ---------------- */

app.get(
  '/api/history',
  (req, res) => {
    try {
      const db = readDB();

      res.json(
        db.verifications
          .slice(-50)
          .reverse()
      );
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Unable to load verification history.'
      });
    }
  }
);

/* ---------------- LEDGER ---------------- */

app.get(
  '/api/ledger',
  (req, res) => {
    try {
      const db = readDB();

      res.json(
        db.anchors
          .slice(-50)
          .reverse()
      );
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Unable to load blockchain ledger.'
      });
    }
  }
);

/* ---------------- VERIFY ---------------- */

app.post(
  '/api/verify',
  upload.single('credential'),

  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            'Please upload a PDF, JPG or PNG credential.'
        });
      }

      const analysis =
        process.env.OPENAI_API_KEY
          ? await realAIAnalysis(req.file)
          : demoAnalysis(req.file);

      const db =
        readDB();

      const record = {
        id:
          crypto.randomUUID(),

        createdAt:
          new Date().toISOString(),

        ...analysis
      };

      db.verifications.push(
        record
      );

      writeDB(db);

      return res.json(
        record
      );
    } catch (error) {
      console.error(
        'Verification error:',
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          'Verification failed.'
      });
    }
  }
);

/* ---------------- ANCHOR ---------------- */

app.post(
  '/api/anchor',

  async (req, res) => {
    try {
      const {
        hash,
        credentialId =
          'UNKNOWN'
      } = req.body || {};

      if (
        !/^[a-f0-9]{64}$/i.test(
          hash || ''
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid SHA-256 hash.'
        });
      }

      const db =
        readDB();

      const existing =
        db.anchors.find(
          item =>
            item.hash &&
            item.hash.toLowerCase() ===
              hash.toLowerCase()
        );

      if (existing) {
        return res.json(
          existing
        );
      }

      let proof =
        await sepoliaAnchor(
          hash,
          credentialId
        );

      /* -------- LOCAL PROOF CHAIN -------- */

      if (!proof) {
        const previousBlockHash =
          db.anchors.length > 0
            ? db.anchors[
                db.anchors.length - 1
              ].blockHash
            : 'GENESIS';

        const timestamp =
          new Date().toISOString();

        const blockHash =
          sha256(
            Buffer.from(
              previousBlockHash +
              hash +
              timestamp +
              credentialId
            )
          );

        proof = {
          network:
            'TRUSTMESH LOCAL PROOF CHAIN',

          blockNumber:
            db.anchors.length + 1,

          hash,

          credentialId,

          timestamp,

          previousBlockHash,

          blockHash,

          status:
            'ANCHORED'
        };
      } else {
        proof = {
          ...proof,

          hash,

          credentialId,

          timestamp:
            new Date().toISOString()
        };
      }

      db.anchors.push(
        proof
      );

      writeDB(db);

      return res.json(
        proof
      );
    } catch (error) {
      console.error(
        'Anchor error:',
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          'Anchoring failed.'
      });
    }
  }
);

/* ---------------- FRONTEND FALLBACK ---------------- */

/*
 * IMPORTANT:
 * Do NOT use app.get('*') with Express 5.
 * Express 5 can reject that route pattern.
 *
 * This middleware safely handles frontend routes
 * without the wildcard path-to-regexp problem.
 */
app.use(
  (req, res, next) => {
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api/')
    ) {
      return next();
    }

    const indexPath =
      path.join(
        publicDir,
        'index.html'
      );

    if (
      fs.existsSync(indexPath)
    ) {
      return res.sendFile(
        indexPath
      );
    }

    return res.status(404).send(
      'TRUSTMESH frontend not found.'
    );
  }
);

/* ---------------- ERROR HANDLER ---------------- */

app.use(
  (error, req, res, next) => {
    console.error(
      'Unhandled server error:',
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      error:
        error.message ||
        'Internal server error.'
    });
  }
);

/*
 * Vercel uses the exported Express application.
 * Local development uses app.listen().
 */
if (!process.env.VERCEL) {
  app.listen(
    port,
    () => {
      console.log(
        `
TRUSTMESH v2
http://localhost:${port}

AI:
${
  process.env.OPENAI_API_KEY
    ? 'REAL AI'
    : 'DEMO AI'
}

Blockchain:
${
  process.env.SEPOLIA_RPC_URL
    ? 'SEPOLIA'
    : 'LOCAL PROOF CHAIN'
}
`
      );
    }
  );
}

export default app;
