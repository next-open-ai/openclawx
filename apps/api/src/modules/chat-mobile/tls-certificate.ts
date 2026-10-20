import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export type ManagedMobileTls = {
  certFile: string;
  keyFile: string;
  caFile: string;
  hosts: string[];
};

function tlsDirectory(env: NodeJS.ProcessEnv) {
  const root = env.OPENCLAWX_DATA_DIR?.trim() || path.join(os.homedir(), '.openclawx');
  return path.join(root, 'mobile-tls');
}

export function managedMobileCaFile(env: NodeJS.ProcessEnv = process.env) {
  return path.join(tlsDirectory(env), 'openclawx-mobile-ca.pem');
}

function normalizedHosts(hosts: string[]) {
  return [...new Set([...hosts, 'localhost', '127.0.0.1'].map(value => value.trim()).filter(Boolean))].sort();
}

function writePrivate(file: string, contents: string) {
  fs.writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
}

function newKeyPair() {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey),
    publicPem: pair.publicKey,
    privatePem: pair.privateKey,
  };
}

function certificateSerial() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function createCa(commonName: string) {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = certificateSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000);
  const attributes = [{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'OpenClawX Local' }];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, privateKey: keys.privateKey, certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function createServerCertificate(ca: ReturnType<typeof createCa>, hosts: string[]) {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = certificateSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60_000);
  cert.validity.notAfter = new Date(Date.now() + 824 * 24 * 60 * 60_000);
  cert.setSubject([{ name: 'commonName', value: hosts[0] || 'localhost' }, { name: 'organizationName', value: 'OpenClawX Local' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts.map(value => {
      const type = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ? 7 : 2;
      return type === 7 ? { type, ip: value } : { type, value };
    }) },
  ]);
  cert.sign(ca.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

export function ensureManagedMobileTls(hostsInput: string[], env: NodeJS.ProcessEnv = process.env): ManagedMobileTls {
  const hosts = normalizedHosts(hostsInput);
  const directory = tlsDirectory(env);
  const caFile = managedMobileCaFile(env);
  const caKeyFile = path.join(directory, 'openclawx-mobile-ca-key.pem');
  const certFile = path.join(directory, 'openclawx-mobile.pem');
  const keyFile = path.join(directory, 'openclawx-mobile-key.pem');
  const metadataFile = path.join(directory, 'metadata.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as { hosts?: string[] };
    if (JSON.stringify(metadata.hosts) === JSON.stringify(hosts)
      && [caFile, caKeyFile, certFile, keyFile].every(file => fs.statSync(file).isFile())) {
      return { certFile, keyFile, caFile, hosts };
    }
  } catch { /* Generate or repair the certificate set. */ }

  let ca: ReturnType<typeof createCa>;
  try {
    const certPem = fs.readFileSync(caFile, 'utf8');
    const keyPem = fs.readFileSync(caKeyFile, 'utf8');
    ca = {
      cert: forge.pki.certificateFromPem(certPem),
      privateKey: forge.pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
    };
  } catch {
    ca = createCa('OpenClawX Mobile Local CA');
    fs.writeFileSync(caFile, ca.certPem, { encoding: 'utf8', mode: 0o644 });
    writePrivate(caKeyFile, ca.keyPem);
  }
  const server = createServerCertificate(ca, hosts);
  fs.writeFileSync(certFile, server.certPem, { encoding: 'utf8', mode: 0o644 });
  writePrivate(keyFile, server.keyPem);
  fs.writeFileSync(metadataFile, JSON.stringify({ version: 1, hosts, generatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { certFile, keyFile, caFile, hosts };
}
