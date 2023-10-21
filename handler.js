'use strict';

const htmlparser2 = require("htmlparser2");
const solveChallenge = require("./solver/main");
const headers = {
    "authority": "ecm.coopculture.it",
    "accept": "text/html, */*; q=0.01",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "referer": "https://ecm.coopculture.it/index.php?option=com_snapp&view=event&id=3793660E-5E3F-9172-2F89-016CB3FAD609&catalogid=B79E95CA-090E-FDA8-2364-017448FF0FA0&lang=it",
    "sec-ch-ua": '"Google Chrome";v="117", "Not;A=Brand";v="8", "Chromium";v="117"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
}

const URL = 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=490E25D6-2465-ED3A-6A13-016ED583FB68&month=11&year=2023&lang=en&_=1697784291404';

const SIGNAL_START = 1;
const SIGNAL_FAIL = 2;
const SIGNAL_SUCCESS = 3;
const catchChallengeScript = async () => {
    let response = await fetch(URL, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers: headers,
    })

    let htmlContent = await response.text()
    let isScriptStarted = false;

    let scriptContent = '';

    const parser = new htmlparser2.Parser({
        onopentag: function(name){
            if (name === 'script' && scriptContent === '') {
                isScriptStarted = true;
            }
        },

        ontext: function(text){
            if (isScriptStarted) {
                scriptContent += text;
            }
        },

        onclosetag(name) {
            if (name === 'script') {
                isScriptStarted = false;
            }
        }
    });

    parser.parseComplete(htmlContent);

    return scriptContent;
}


const catchDates = async (cookies) => {
    let cookieString = '';
    for (const cookieName in cookies) {
        cookieString += `${cookieName}=${cookies[cookieName]};`
    }

    let response = await fetch(URL, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers: Object.assign({
            "Cookie": cookieString,
        }, headers),
    })

    const datesAvailable = {};

    const parser = new htmlparser2.Parser({
        onopentag: function(name, attribs){
            if (name === 'div') {
                const classList = (attribs.class || "").split(' ');
                if (classList.includes("day-number")) {
                    const date = attribs['data-date'];
                    datesAvailable[date] = classList.includes("available");
                }
            }
        },
    });

    parser.parseComplete(await response.text());

    return datesAvailable;
}

const filterAvailableDates = (dates) => {
    const availableDates = [];
    for (const date in dates) {
        if (dates[date]) {
            availableDates.push(date);
        }
    }
    return availableDates;
}

const sendHealthCheck = async (signal, postData) => {
    let signalString = '';
    if (signal === SIGNAL_SUCCESS) {
        signalString = '';
    } else if (signal === SIGNAL_FAIL) {
        signalString = '/fail';
    } else if (signal === SIGNAL_START) {
        signalString = '/start';
    } else {
        console.log('Unknown signal');
        return;
    }

    if (!postData) {
        postData = '';
    }

    if (typeof postData !== 'string') {
        postData = JSON.stringify(postData, null, 2);
    }

    await fetch(process.env.HEALTHCHECK_URL + signalString, {
        method: "POST",
        credentials: "omit",
        cache: "no-cache",
        headers: {
            "Content-Type": "text/plain",
        },
        body: postData,
    })

}

const sendToTelegram = async (message) => {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    const sendMessagePayload = {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
    }

    const response = await fetch(telegramUrl, {
        method: "POST",
        credentials: "omit",
        cache: "no-cache",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(sendMessagePayload),
    })

    const telegramResponse = await response.json();

    if (!telegramResponse['ok']) {
        throw new Error('Telegram response is not ok: ' + JSON.stringify(telegramResponse));
    }
}

module.exports.check = async (event) => {

    sendHealthCheck(SIGNAL_START).then();

    try {
        let scriptContent = await catchChallengeScript();
        const cookies = solveChallenge(scriptContent)

        console.log(cookies);

        let dates = await catchDates(cookies);

        const availableDates = filterAvailableDates(dates);
        console.log(availableDates);

        await sendToTelegram(`Available dates: ${availableDates.join(', ')}`);

        await sendHealthCheck(SIGNAL_SUCCESS, availableDates);

    } catch (e) {
        console.log(e);
        await sendHealthCheck(SIGNAL_FAIL, e.message);
    }

  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: 'Go Serverless v1.0! Your function executed successfully!',
        input: event,
      },
      null,
      2
    ),
  };

  // Use this code if you don't use the http event with the LAMBDA-PROXY integration
  // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};

module.exports.check();
