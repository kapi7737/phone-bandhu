# PhoneBandhu

PhoneBandhu's storefront, admin dashboard, and Express/MongoDB API are kept together in this repository. The backend serves the storefront too, so one server runs the complete app locally or on Render.

## Run the connected app

1. In a terminal, go to this repository's `backend` folder.
2. Install dependencies with `npm install` if needed.
3. Copy `.env.example` to `.env` and set `MONGO_URI` to your MongoDB connection string.
4. Start the combined app with `npm start`.
5. Open `http://localhost:5200`.

The API is available under `/api`; the health endpoint is `/api/health`. When using a separate static web server on port 5500, the pages connect to the API at `http://localhost:5200`.

Keep `.env` private. The checked-in `.env.example` contains placeholders only.

## Security setup

The admin dashboard and customer-data APIs are locked behind server-verified sessions. Configure the admin credentials in `backend/.env` before using `admin.html`:

1. In this repository's `backend` folder, run `npm run admin:hash` in an interactive terminal and enter a unique password of at least 12 characters. The password is hidden while typing; copy the generated `ADMIN_PASSWORD_HASH` line into `.env`.
2. Set `ADMIN_EMAIL` to the administrator's email address. Never put the admin password itself in frontend files or share it in chat.
3. Restart the backend and sign in at `admin.html` with that email and password.

Production must use HTTPS, a random `SESSION_SECRET` of at least 32 bytes, and the exact frontend origin in `APP_ORIGINS` when the frontend is hosted separately. Set `NODE_ENV=production` and `PUBLIC_APP_URL` to the HTTPS site URL. Generate a session secret in the backend terminal with `node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"`, then store it only in `backend/.env` or the hosting provider's secret settings. Keep `.env` out of version control.

These changes add access control and common browser/API protections; they do not make any public website impossible to attack. Keep Node and dependencies updated, use an Atlas IP access rule limited to the server's network, and review Atlas credentials if they have ever been exposed.

### Master admin and activity tracking

The `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` configured above always identify the master admin. After signing in with that account, use the **Master Admin: Manage Admin Accounts** panel to create another admin with a unique email and initial password. New accounts start as pending; only the master admin can approve, reject, or disable them. Approved admins can use the existing operations dashboard, but cannot manage other admin accounts or view the audit log.

The master admin can review who changed an order, inventory listing, or customer account in the **Admin Activity Log**. Admin approvals and account state changes are logged there too. Logs are stored in MongoDB and show the latest 500 entries.

Use **Reset password** beside an admin account, or open `admin-password-reset.html`, to set a new admin password. This master-only action revokes the affected admin's current session and is added to the activity log. Admin sessions expire after 8 hours and are cleared when the backend restarts. `SESSION_SECRET` should be a random value of at least 32 bytes; `ADMIN_EMAIL` and the bcrypt `ADMIN_PASSWORD_HASH` identify the master account.

Buyback requests move through inspection, a final offer in the customer's account, the customer's accept/decline decision, and a final admin confirmation that PhoneBandhu received the device and paid the seller. Only then does the phone become available in the store. The admin activity log records offer changes, customer decisions, and publication.

## Deploy to Render

This repo includes `render.yaml` for a free Node web service. In Render, create a Blueprint from this GitHub repository, then add the environment variables listed in `backend/.env.example` in the service settings. Set `MONGO_URI`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH`; add email and payment keys only if those features are configured. Render provides `PORT` automatically. The app and API share one Render URL, so browser requests use the same origin and no separate `APP_ORIGINS` value is needed. Add the Render service's outbound IP ranges from its dashboard to the Atlas project's IP access list. Free services sleep after inactivity and can take about a minute to wake.
