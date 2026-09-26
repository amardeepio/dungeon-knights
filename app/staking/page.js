import StakingClient from './client';
import { SITE_NAME, SITE_URL } from '../../lib/site';

export const metadata = {
  title: { absolute: 'Staking Vault — Dungeon Knights' },
  description: 'Stake Genesis Knights to earn from the weekly DNG pool and enter the weekly capsule raffle.',
  alternates: { canonical: '/staking' },
  openGraph: {
    url: '/staking',
    title: `${SITE_NAME} — Staking Vault`,
    description: 'Stake Genesis Knights to earn from the weekly DNG pool and enter the weekly capsule raffle.',
  },
};

export const viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
    userScalable: true,
    viewportFit: 'cover',
    themeColor: '#12100E',
};

export default function StakingPage() {
  return <StakingClient />;
}
