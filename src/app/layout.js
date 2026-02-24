import "./globals.css";

export const metadata = {
  title: "Scribble - Draw, Guess & Have Fun!",
  description:
    "A multiplayer drawing and guessing game. Play with your friends!",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
