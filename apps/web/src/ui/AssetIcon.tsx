import { siBinance, siBitcoin, siDogecoin, siEthereum, siSolana, siTether, siXrp, type SimpleIcon } from 'simple-icons';

const cryptoIcons: Record<string, SimpleIcon> = {
  BTC: siBitcoin,
  ETH: siEthereum,
  USDT: siTether,
  SOL: siSolana,
  BNB: siBinance,
  XRP: siXrp,
  DOGE: siDogecoin,
};

const currencyGlyphs: Record<string, string> = {
  CNY: '¥', USD: '$', HKD: 'HK', EUR: '€', GBP: '£', JPY: '¥',
  SGD: 'S', TWD: 'NT', AUD: 'A', NZD: 'NZ', CAD: 'C', CHF: 'Fr', USDC: '$',
  SHIB: 'SH', PEPE: 'PE',
};

/** A local, theme-aware mark; the adjacent asset code remains the unambiguous label. */
export function AssetIcon({ code, symbol, size = 28 }: { code: string; symbol?: string; size?: number }) {
  const normalized = code.trim().toUpperCase();
  const brand = cryptoIcons[normalized];
  const fallback = symbol?.trim() && symbol.trim().length <= 2 ? symbol.trim() : normalized.slice(0, 2) || '¤';
  return <span className="zc-asset-icon" style={{ width: size, height: size }} aria-hidden="true">
    {brand ? <svg viewBox="0 0 24 24" fill="currentColor"><path d={brand.path} /></svg>
      : <span>{currencyGlyphs[normalized] ?? fallback}</span>}
  </span>;
}
