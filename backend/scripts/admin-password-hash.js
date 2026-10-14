const bcrypt = require('bcrypt');

const input = process.stdin;
if (!input.isTTY || typeof input.setRawMode !== 'function') {
    console.error('Run this command in an interactive terminal so the password stays hidden.');
    process.exit(1);
}

let password = '';
process.stdout.write('New admin password (12–72 UTF-8 bytes): ');
input.setEncoding('utf8');
input.setRawMode(true);
input.resume();
input.on('data', async chunk => {
    for (const character of chunk) {
        if (character === '\u0003') {
            input.setRawMode(false);
            process.stdout.write('\nCancelled.\n');
            process.exit(1);
        }
        if (character === '\r' || character === '\n') {
            input.setRawMode(false);
            input.pause();
            if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
                process.stdout.write('\nPassword must be at least 12 characters and no more than 72 UTF-8 bytes.\n');
                process.exitCode = 1;
                return;
            }
            const hash = await bcrypt.hash(password, 12);
            password = '';
            process.stdout.write(`\nADMIN_PASSWORD_HASH=${hash}\n`);
            return;
        }
        if (character === '\u007f' || character === '\b') {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
        } else if (character >= ' ') {
            password += character;
            process.stdout.write('*');
        }
    }
});
