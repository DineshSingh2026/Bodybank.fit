# Google Sign-In Setup

To use **Continue with Google** on the login/signup modals, configure a Google OAuth Client ID.

## Steps

1. **Get a Client ID**
   - Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Create or select a project
   - Click **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Add **Authorized JavaScript origins** (e.g. `http://localhost:3000` for local dev, and your production URL)
   - Copy the **Client ID** (it looks like `xxxxx.apps.googleusercontent.com`)

2. **Configure the app**
   - Open the `.env` file in this project root (copy from `.env.example` if it doesn’t exist)
   - Set:
     ```env
     GOOGLE_CLIENT_ID=your_actual_client_id_here.apps.googleusercontent.com
     ```
   - Save the file

3. **Restart the server**
   - Stop the Node server (Ctrl+C) and run `npm start` again so it loads the new value.

After this, clicking **Continue with Google** on the login or signup modal will open Google’s sign-in and then log the user in.
