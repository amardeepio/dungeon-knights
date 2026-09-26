'use client';

/**
 * Shared NFT showcase card — one component for portfolio / staking / genesis.
 * Dark-fantasy-terminal: Cinzel name, mono numbers, rarity accent var, tilt+glow.
 * Pure presentational: all numbers are passed in, nothing is fetched here.
 */

function rarityClass(rarity, isGenesis) {
  if (isGenesis) return 'nft-rarity-genesis';
  const key = String(rarity || '').toLowerCase();
  if (['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(key)) return `nft-rarity-${key}`;
  return '';
}

export default function NftCard({
  art,
  badge,
  title,
  tokenId,
  hp,
  hpMin,
  hpMax,
  metaTop,
  metaBottom,
  rarity,
  isGenesis = false,
}) {
  const pct = hpMin != null && hpMax != null && hpMax > hpMin && Number.isFinite(Number(hp))
    ? Math.min(100, Math.max(0, ((Number(hp) - hpMin) / (hpMax - hpMin)) * 100))
    : null;

  return (
    <article className={`nft-card ${rarityClass(rarity, isGenesis)}`} tabIndex={0} aria-label={title || `NFT #${tokenId}`}>
      <div className="nft-card-media">
        {art ? (
          <img src={art} alt="" loading="lazy" decoding="async" width={320} height={320} />
        ) : null}
        {badge ? <span className="nft-badge">{badge}</span> : null}
        {tokenId != null ? <span className="nft-card-id nft-num">#{tokenId}</span> : null}
      </div>
      <div className="nft-card-body">
        {title ? <div className="nft-card-title">{title}</div> : null}
        {metaTop ? <div className="nft-card-sub nft-num">{metaTop}</div> : null}
        {pct != null ? (
          <div className="nft-hp-track" role="img" aria-label={`Hash power ${hp} of ${hpMin} to ${hpMax}`}>
            <div className="nft-hp-fill" style={{ width: `${Math.round(pct)}%` }} />
          </div>
        ) : null}
        {metaBottom ? (
          <div className="nft-meta-row nft-num"><span>{metaBottom}</span>{hp != null ? <strong>{hp} HP</strong> : null}</div>
        ) : hp != null ? (
          <div className="nft-meta-row nft-num"><span>Hash power</span><strong>{hp} HP</strong></div>
        ) : null}
      </div>
    </article>
  );
}
