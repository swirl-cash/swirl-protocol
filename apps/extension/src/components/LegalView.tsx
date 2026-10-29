import { ArrowLeft, FileText, ShieldCheck } from 'lucide-react';

export type LegalKind = 'terms' | 'privacy';

type LegalSection = { heading: string; paragraphs: string[] };

const TERMS: LegalSection[] = [
  { heading: '1. Agreement and eligibility', paragraphs: [
    'These Terms govern your use of the SWIRL Wallet browser extension and its interfaces. By using the software, you agree to these Terms. If you do not agree, do not use it.',
    'You must be legally able to enter into this agreement and use the software only where doing so is lawful. You are responsible for complying with the laws, sanctions rules, tax obligations and other requirements that apply to you.',
  ] },
  { heading: '2. Non-custodial software', paragraphs: [
    'SWIRL Wallet is software, not a bank, exchange, broker, custodian or financial adviser. You control your recovery phrase, keys and transaction approvals. SWIRL does not take possession of your assets and cannot recover a lost recovery phrase or reverse a blockchain transaction.',
    'Private notes and viewing keys can reveal sensitive transaction information. Keep them secure and share them only when you understand the consequences.',
  ] },
  { heading: '3. Transactions and third-party services', paragraphs: [
    'Blockchain transactions may require network fees, protocol fees and Relayer fees. The applicable fee is shown before submission where supported. Quotes can expire, networks can congest and transactions can fail.',
    'RPC providers, indexers, Relayers, dApps, token issuers, blockchains and external links are independent services. Their availability, conduct and terms are outside our control. A Relayer may submit transactions and pay gas but does not receive your spending keys.',
  ] },
  { heading: '4. Acceptable use', paragraphs: [
    'Do not use the software to violate applicable law, infringe rights, distribute malware, interfere with networks or services, bypass security controls, or facilitate fraud, theft or other unlawful activity. You are responsible for reviewing every address, network, amount and approval before confirming it.',
  ] },
  { heading: '5. Experimental software and risk', paragraphs: [
    'This is a development build. Cryptographic systems, smart contracts, wallet software and third-party infrastructure may contain defects or be attacked. Privacy features do not guarantee absolute anonymity, and blockchain records may remain public permanently.',
    'The software is provided “as is” and “as available”, without warranties of merchantability, fitness for a particular purpose, availability, security or non-infringement to the maximum extent permitted by law. Do not use valuable assets until the relevant components have been independently audited and expressly released for production.',
  ] },
  { heading: '6. Liability and changes', paragraphs: [
    'To the maximum extent permitted by law, SWIRL contributors will not be liable for indirect, incidental, special or consequential losses, or for losses caused by lost keys, user error, failed transactions, unavailable services, malicious dApps, market movements or third-party infrastructure.',
    'Features and these Terms may change as the software develops. The version displayed in the wallet applies to that release. Continued use after an update constitutes acceptance of the updated Terms.',
  ] },
];

const PRIVACY: LegalSection[] = [
  { heading: '1. Information stored on your device', paragraphs: [
    'SWIRL Wallet does not require an account, name or email address. Your recovery phrase is encrypted locally with your password. Settings, activity labels and wallet state are stored in your browser profile. Passwords are not stored, and locking the wallet clears unlocked key material from the wallet page.',
    'Anyone with access to your browser profile, device or recovery phrase may be able to access your wallet. Protect your device and keep an offline backup.',
  ] },
  { heading: '2. Network and blockchain data', paragraphs: [
    'When you synchronize balances or submit transactions, the wallet sends necessary requests to the configured RPC endpoint and may contact an indexer or Relayer. These services can observe technical data such as IP address, requested chain or vault, public account queries, transaction payloads and timestamps.',
    'Blockchain transactions, public addresses, token amounts and contract events may be publicly visible and permanent. Encryption and zero-knowledge proofs protect specific note data; they do not erase public network metadata or guarantee anonymity.',
  ] },
  { heading: '3. Relayers, dApps and external services', paragraphs: [
    'A Relayer receives the proof and encrypted outputs needed to submit a private transaction, plus the encrypted fee note required by its quote. It does not receive your recovery phrase or spending key. It may still observe submission metadata or decline a request.',
    'When you connect to a dApp, you approve the account and actions shared with that site. RPC price services may receive asset-price requests. External websites, including the official X help page, have their own privacy practices.',
  ] },
  { heading: '4. Your choices and controls', paragraphs: [
    'You can use direct-wallet submission where supported instead of a Relayer, hide supported networks, disconnect dApps, lock the wallet, or remove the extension. Removing the extension or browser data may delete the only local encrypted wallet copy; back up your recovery phrase first.',
    'You can reveal a viewing key to disclose private note history deliberately. Treat that disclosure as sensitive and irreversible.',
  ] },
  { heading: '5. Retention and changes', paragraphs: [
    'Local wallet data remains on your device until you delete it or clear browser storage. Data sent to blockchains or independent infrastructure is governed by those systems and may not be deletable.',
    'This policy may be updated with new releases. Material changes should be reflected in the updated wallet document.',
  ] },
];

export function LegalView({ kind, onBack }: { kind: LegalKind; onBack: () => void }) {
  const isPrivacy = kind === 'privacy';
  const sections = isPrivacy ? PRIVACY : TERMS;
  return <div className="legal-view">
    <div className="legal-heading"><button className="icon-button small back-button" onClick={onBack} aria-label="Back to settings"><ArrowLeft size={18} /></button><span className="settings-icon">{isPrivacy ? <ShieldCheck size={17} /> : <FileText size={17} />}</span><div><p className="eyebrow">SWIRL WALLET</p><h2>{isPrivacy ? 'Privacy Policy' : 'Terms of Service'}</h2></div></div>
    <p className="legal-updated">Last updated · October 27, 2026</p>
    <p className="legal-intro">{isPrivacy ? 'This policy explains what the wallet stores locally and what may be shared when you use networks and third-party infrastructure.' : 'Please read these Terms before using this development wallet. They explain your control, your responsibilities and the limits of the software.'}</p>
    <div className="legal-sections">{sections.map((section) => <section key={section.heading}><h3>{section.heading}</h3>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>)}</div>
    <button className="secondary-button legal-back" onClick={onBack}>Back to settings</button>
  </div>;
}
