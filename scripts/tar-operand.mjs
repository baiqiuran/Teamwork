import { relative } from "node:path";

// GNU tar reads an operand containing a colon as "host:path", so on Windows an
// absolute archive path such as C:\...\application.tar.gz is parsed as a remote
// host and extraction dies with "Cannot connect to C:". Give tar a relative
// operand instead; forward slashes work for both GNU tar and Windows bsdtar.
export const tarOperand = (from, target) =>
  relative(from, target).replaceAll("\\", "/");
