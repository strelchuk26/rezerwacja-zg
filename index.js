import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";
import path from "path";
import cron from "node-cron";
import { Bot, InlineKeyboard } from "grammy";

dotenv.config();

const app = express();
const bot = new Bot(process.env.BOT_TOKEN || "");

admin.initializeApp({
    credential: admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
    }),
});
const db = admin.firestore();
const USERS_COLLECTION = "telegram_users";

const serverURL =
    "https://plugin.bookero.pl/plugin-api/v2/getMonth?bookero_id=SnLKupjwDaPO&lang=pl&periodicity_id=0&custom_duration_id=0&service=55039&worker=0&plugin_comment=%7B%22data%22:%7B%22parameters%22:%7B%7D%7D%7D&phone=&people=1&email=&plus_months=0";

async function saveUser(chatId, username) {
    try {
        const userRef = db.collection(USERS_COLLECTION).doc(chatId.toString());
        await userRef.set({ chatId, username }, { merge: true });
        console.log(`User ${username} with chatId ${chatId} saved successfully.`);
    } catch (error) {
        console.error("Error saving user to Firestore:", error);
        throw new Error("Failed to save user.");
    }
}

async function getAllUsers() {
    try {
        const snapshot = await db.collection(USERS_COLLECTION).get();
        return snapshot.docs.map((doc) => doc.data().chatId);
    } catch (error) {
        console.error("Error fetching users from Firestore:", error);
        throw new Error("Failed to fetch users.");
    }
}

async function fetchData() {
    try {
        const response = await axios.get(serverURL);
        return response.data;
    } catch (error) {
        console.error(error);
        return null;
    }
}

bot.catch((err) => {
    console.error("Error occurred:", err);
});

bot.command("start", async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const username = ctx.from?.username || "Unknown";
        await saveUser(chatId, username);
        ctx.reply(
            "Привіт! Тепер ти будеш отримувати повідомлення про вільні дати. Використовуй /checkFreeDate для перевірки вільних дат."
        );
    } catch (error) {
        console.error(error);
    }
});

bot.command("checkFreeDate", async (ctx) => {
    try {
        const data = await fetchData();
        if (data) {
            if (data.first_free_term) {
                const keyboard = new InlineKeyboard().url("Зарезервуй!", `https://rezerwacja.zielona-gora.pl/`);
                ctx.reply(`Перша вільна дата для резервування: ${data.first_free_term}`, { reply_markup: keyboard });
            } else {
                ctx.reply("Немає вільних термінів.");
            }
        } else {
            ctx.reply("Під час отримання даних сталася помилка.");
        }
    } catch (error) {
        console.error(error);
    }
});

async function checkAndNotifyUsers() {
    try {
        const data = await fetchData();
        if (data && data.first_free_term) {
            const keyboard = new InlineKeyboard().url("Зарезервуй!", `https://rezerwacja.zielona-gora.pl/`);
            const users = await getAllUsers();
            for (const chatId of users) {
                try {
                    await bot.api.sendMessage(chatId, `Перша вільна дата для резервування: ${data.first_free_term}`, {
                        reply_markup: keyboard,
                    });
                } catch (err) {
                    console.error(`Не вдалося відправити повідомлення користувачу ${chatId}:`, err);
                }
            }
        }
    } catch (error) {
        console.error("Error in checkAndNotifyUsers:", error);
    }
}

cron.schedule("*/20 * * * *", async () => {
    console.log(`Розсилка... ${new Date().toISOString()}`);
    await checkAndNotifyUsers();
});

bot.start();

app.listen(5000, (err) => console.log(`Server listening on PORT: 5000`));
