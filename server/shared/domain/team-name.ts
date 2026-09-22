export const teamNameKey = (name: string) =>
  name
    .trim()
    .normalize("NFKC")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
