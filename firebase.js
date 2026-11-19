// VOZRIK Firebase web configuration
// This web config is intended for browser use. Secure your data with Firebase Security Rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCiIA-0f1RHmYWngiaf1vdbYFpTMj5VTBE",
  authDomain: "vozrik-store.firebaseapp.com",
  projectId: "vozrik-store",
  storageBucket: "vozrik-store.firebasestorage.app",
  messagingSenderId: "274668696789",
  appId: "1:274668696789:web:f886b57436db941cf65e5c"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
