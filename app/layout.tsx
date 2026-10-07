import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'FAB TWIN — Semiconductor Manufacturing Digital Twin',
  description:
    'Local-first interactive 3D digital twin of semiconductor manufacturing: from quartz to crystal, wafer, fab, transistor, die, package and the computer it ends up in.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07090b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
