import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/plus-jakarta-sans';
import './tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'How a computer chip is made · FAB/TWIN',
  description: 'Scroll through 13 short steps and watch, in 3D, how ordinary sand becomes the chip inside your computer.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
  themeColor: '#0a0d0c', // = --bg in app/tokens.css
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
