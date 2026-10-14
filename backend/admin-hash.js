const readline = require('readline');
const bcrypt = require('bcrypt');

const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
input._writeToOutput = function _writeToOutput() {};
process.stdout.write('Master admin password (12–72 characters): ');
input.question('', async password => {
    input.close();
    if (password.length < 12 || password.length > 72) {
        console.error('Password must be between 12 and 72 characters.');
        process.exitCode = 1;
        return;
    }
    const hash = await bcrypt.hash(password, 12);
    console.log(`ADMIN_PASSWORD_HASH=${hash}`);
});
