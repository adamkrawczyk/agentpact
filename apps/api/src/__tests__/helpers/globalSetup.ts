export default async function globalSetup() {
  return async () => {
    const { shutdown } = await import("../../index.js");
    await shutdown();
  };
}
