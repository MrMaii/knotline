export function withoutKnotlineLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("KNOTLINE_")),
  );
}
