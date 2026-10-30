// Keep portable builds practical on everyday Windows laptops.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '3';
const { build, Platform } = await import('electron-builder');
await build({ targets: Platform.WINDOWS.createTarget('portable') });
