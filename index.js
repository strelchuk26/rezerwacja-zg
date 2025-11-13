import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";
import cron from "node-cron";
import { Bot, InlineKeyboard, Keyboard } from "grammy";

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
let lastDates = {};

const BASE_URL =
    "https://plugin.bookero.pl/plugin-api/v2/getMonth?bookero_id=SnLKupjwDaPO&lang=pl&periodicity_id=0&custom_duration_id=0&worker=0&plugin_comment=%7B%22data%22:%7B%22parameters%22:%7B%7D%7D%7D&phone=&people=1&email=&plus_months=0";

function getServiceUrl(serviceId) {
    return `${BASE_URL}&service=${serviceId}`;
}

const SERVICES = {
    PKK_FOREIGNERS: 55039, // Foreigners PKK
    PLASTIC_LICENCE: 37752, // Plastic licence
    REGISTRATION_RP: 13457, // Registration in RP
    REGISTRATION_ABROAD: 16953, // Registration from abroad
};

app.get("/", (req, res) => {
    res.send("Server is running!");
});

async function saveUser(chatId, username, registrationDate, firstName, subscription = null, approved = false) {
    try {
        const userRef = db.collection(USERS_COLLECTION).doc(chatId.toString());
        await userRef.set({ chatId, username, registrationDate, firstName, subscription, approved }, { merge: true });
        console.log(`User ${username} with chatId ${chatId} saved successfully.`);
    } catch (error) {
        console.error("Error saving user to Firestore:", error);
        throw new Error("Failed to save user.");
    }
}

async function fetchData(serviceId) {
    try {
        const response = await axios.get(getServiceUrl(serviceId));
        return response.data;
    } catch (error) {
        console.error(error);
        return null;
    }
}

bot.catch((err) => {
    console.error("Error occurred: ", err);
});

bot.command("start", async (ctx) => {
    try {
        const chatId = ctx.chat?.id?.toString();
        const username = ctx.from?.username || "Chat ID: " + chatId;
        const registrationDate = new Date().toISOString();
        const firstName = ctx.from?.first_name || "Unknown";

        const userRef = db.collection(USERS_COLLECTION).doc(chatId);
        const doc = await userRef.get();

        if (!doc.exists) {
            await saveUser(chatId, username, registrationDate, firstName);
            await ctx.reply(
                "Очікуй підтвердження від адміністратора перед початком користування ботом.\nАдміністратор - @whynot1337.\nПожиттєва підписка коштує 50 PLN."
            );

            const approveKeyboard = new InlineKeyboard().text("✅ Дозволити", `approve_${chatId}`);
            await bot.api.sendMessage(
                process.env.ADMIN_CHAT_ID.toString(),
                `Новий запит на доступ від користувача @${username} (${firstName})`,
                { reply_markup: approveKeyboard }
            );
        } else {
            const data = doc.data();
            if (!data.approved) {
                await ctx.reply(
                    "Очікуй підтвердження від адміністратора перед початком користування ботом.\nАдміністратор - @whynot1337.\nПожиттєва підписка коштує 50 PLN."
                );
            } else {
                await ctx.reply(
                    "Вітаю! Ти вже підписаний на бота. Використовуй команду /services, щоб обрати сервіс для сповіщення."
                );
            }
        }
    } catch (error) {
        console.error(error);
    }
});

bot.command("services", async (ctx) => {
    const keyboard = new InlineKeyboard()
        .text("PKK (іноземці)", "sub_PKK_FOREIGNERS")
        .text("Посвідчення водія", "sub_PLASTIC_LICENCE")
        .row()
        .text("Реєстрація з РП", "sub_REGISTRATION_RP")
        .text("Реєстрація з-за кордону", "sub_REGISTRATION_ABROAD");

    await ctx.reply("Оберіть сервіс, який хочете відстежувати:", {
        reply_markup: keyboard,
    });
});

bot.command("notifyUnapproved", async (ctx) => {
    const chatId = ctx.chat?.id?.toString();

    try {
        if (chatId === process.env.ADMIN_CHAT_ID.toString()) {
            const snapshot = await db.collection(USERS_COLLECTION).where("approved", "==", false).get();
            if (snapshot.empty) {
                await ctx.reply("Немає користувачів, які очікують на підтвердження.");
                return;
            }

            const message = "Вітаємо! Щоб почати користуватися ботом, потрібно оплатити пожиттєву підписку в розмірі 50 PLN. Для оплати звертайся до адміністратора: @whynot1337.";

            for (const doc of snapshot.docs) {
                const user = doc.data();
                try {
                    await bot.api.sendMessage(user.chatId, message);
                    console.log(`✅ Повідомлення надіслано користувачу ${user.chatId}`);
                } catch (err) {
                    console.error(`❌ Не вдалося надіслати повідомлення користувачу ${user.chatId}:`, err);
                }
            }

            await ctx.reply("Сповіщення було надіслано всім непідтвердженим користувачам.");
        }
    } catch (error) {
        console.error("Error in notifyUnapproved command:", error);
        await ctx.reply("Сталася помилка при обробці запиту.");
    }
});


bot.command("checkfreedate", async (ctx) => {
    try {
        const userRef = db.collection(USERS_COLLECTION).doc(ctx.chat?.id?.toString());
        const user = (await userRef.get()).data();

        const data = await fetchData(SERVICES[user.subscription]);

        if (data) {
            if (data.first_free_term) {
                console.log(`${ctx.from?.username}: ${data.first_free_term}`);
                lastDates[user.subscription] = data.first_free_term;
                const keyboard = new InlineKeyboard().url("Зарезервуй!", `https://rezerwacja.zielona-gora.pl/`);
                ctx.reply(
                    `Перша вільна дата для резервування (${formatServiceName(user.subscription)}): ${
                        data.first_free_term
                    }`,
                    {
                        reply_markup: keyboard,
                    }
                );
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

bot.callbackQuery(/^sub_/, async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    const subscriptionKey = ctx.callbackQuery.data.replace("sub_", "");

    if (!chatId || !SERVICES[subscriptionKey]) {
        return await ctx.answerCallbackQuery({ text: "Помилка при обробці вибору.", show_alert: true });
    }

    await db.collection(USERS_COLLECTION).doc(chatId).update({ subscription: subscriptionKey });
    await ctx.answerCallbackQuery({ text: "✅ Сервіс обрано!" });

    await ctx.reply(
        `Ти підписався на сповіщення про вільні дати для: *${formatServiceName(
            subscriptionKey
        )}*. \nВикористовуй команду /checkfreedate, щоб перевірити наявність вільних дат.`,
        { parse_mode: "Markdown" }
    );
});

bot.callbackQuery(/^approve_/, async (ctx) => {
    const chatId = ctx.callbackQuery.data.split("_")[1];
    await db.collection(USERS_COLLECTION).doc(chatId).update({ approved: true });
    await ctx.reply(`Користувачу ${chatId} дозволено доступ.`);
    await bot.api.sendMessage(
        chatId,
        "✅ Адміністратор підтвердив доступ. Тепер ти можеш користуватися ботом.\nЩоб вибрати сервіс для сповіщення — напиши команду /services"
    );
    await ctx.answerCallbackQuery();
});

async function checkAndNotifyUsers() {
    try {
        for (const [subscriptionKey, serviceId] of Object.entries(SERVICES)) {
            const data = await fetchData(serviceId);

            if (data && data.first_free_term) {
                if (lastDates[subscriptionKey] === data.first_free_term) continue;

                lastDates[subscriptionKey] = data.first_free_term;
                console.log(`🔔 Нова дата для ${subscriptionKey}: ${data.first_free_term}`);

                const keyboard = new InlineKeyboard().url("Зарезервуй!", `https://rezerwacja.zielona-gora.pl/`);

                const snapshot = await db
                    .collection(USERS_COLLECTION)
                    .where("subscription", "==", subscriptionKey)
                    .where("approved", "==", true)
                    .get();

                const users = snapshot.docs.map((doc) => doc.data().chatId);

                for (const chatId of users) {
                    try {
                        await bot.api.sendMessage(
                            chatId,
                            `🔔 Перша вільна дата для *${formatServiceName(subscriptionKey)}*: ${data.first_free_term}`,
                            {
                                parse_mode: "Markdown",
                                reply_markup: keyboard,
                            }
                        );
                        console.log(`✅ Повідомлення надіслано користувачу ${chatId}`);
                    } catch (err) {
                        console.error(`❌ Не вдалося надіслати повідомлення користувачу ${chatId}:`, err);
                    }
                }
            }
        }
    } catch (error) {
        console.error("❌ Помилка в checkAndNotifyUsers:", error);
    }
}

function formatServiceName(key) {
    switch (key) {
        case "PKK_FOREIGNERS":
            return "PKK для іноземців";
        case "PLASTIC_LICENCE":
            return "Отримання посвідчення водія";
        case "REGISTRATION_RP":
            return "Реєстрація авто з РП";
        case "REGISTRATION_ABROAD":
            return "Реєстрація авто з-за кордону";
        default:
            return key;
    }
}

cron.schedule("*/10 * * * *", async () => {
    console.log(`Розсилка...`, new Date().toLocaleString());
    await checkAndNotifyUsers();
});

bot.start();

app.listen(5000, (err) => console.log(`Server running.`));
