module.exports = {
    testDir: 'tests',
    testMatch: '**/*.spec.cjs',
    workers: 1,
    use: {
        headless: true,
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    },
    reporter: 'list',
};
