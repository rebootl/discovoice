const Discord = require('discord.js');
const fs = require('fs');
const url = require('url');
const https = require('https');
const googleTTS = require('google-tts-api');
const fetchVideoInfo = require('youtube-info');
const config = require('./config.json');

const client = new Discord.Client();

client.login(config.token);
const channelId = config.voiceChannelId;
const ttsChannelId = config.textChannelId;
const selectiveMode = true;

const users = {};

const commands = {
  ignore: (parts, message, {currentlySpeaking, filters})=>{
    if (typeof parts[1] !== 'string') return;
    const [, id] = filters.userFilter.regex.exec(parts[1]) || [];
    if (id) {
      delete currentlySpeaking[id];
      message.reply('I\'m going to ignore '+parts[1]);
    }
    message.delete().catch(e=>{});
  },
  shush: (parts, message, {currentStream})=>{
    currentStream.end();
    message.reply('shhhh');
    message.delete().catch(e=>{});
  },
  restart: (parts, message)=>{
    // note: everyone can restart the server.. might need some ACL, but that beyond scope right now
    message.reply('bee boop bee boop');
    process.exit(0);
  },
};

const filters = {
  emoteFilter: {
    regex: /<a?:(\w*):[0-9]*>/,
    run: (message, tag) => {
      return message.content.replace(tag[0], tag[1]);
    },
  },
  tagFilter: {
    regex: /<#([0-9]*)>/,
    run: (message, tag) => {
      let channel = client.channels.cache.get(tag[1]);
      return message.content.replace(tag[0], '# '+channel.name);
    }
  },
  userFilter: {
    regex: /<@!?([0-9]*)>/,
    run: (message, tag) => {
      let user = message.guild.members.cache.get(tag[1]).user;
      return message.content.replace(tag[0], '@ '+user.username);
    }
  },
  rolesFilter: {
    regex: /<@&([0-9]*)>/,
    run: (message, tag) => {
      let role = message.guild.roles.cache.get(tag[1]);
      return message.content.replace(tag[0], '@ '+role.name);
    }
  },
  youtubeFilter: {
    regex: /(https:\/\/)?(www\.)?youtube\.[a-z]{2,6}\/watch\?([-a-zA-Z0-9@:%_\+.~#?&//=]*)/,
    run: async (message, tag) => {
      let id =  new URL(tag[0]).searchParams.get('v');
      let info = await fetchVideoInfo(id);
      return message.content.replace(/(https:\/\/)?(www\.)?youtube\.[a-z]{2,6}\/watch\?([-a-zA-Z0-9@:%_\+.~#?&//=]*)/, info.title);
    }
  },
  linkFilter: {
    regex: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/,
    run: (message, tag) => {
      return message.content.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/, 'url');
    }
  },
  blockQuoteFilter: {
    regex: /\`{3,}/,
    run: (message, tag) => {
      let matches = Array.from(message.content.matchAll(/\`{3,}/g)).map(x => x.index);
      let result = message.content;
      for (let i = (((matches.length / 2) | 0) * 2) - 2; i >= 0; i -= 2) {
        result = result.slice(0, matches[i]) + 'code' + result.slice(matches[i + 1] + 3);
      }
      return result;
    }
  }
}

client.on('ready', async () => {
  const ttsChannel = await client.channels.cache.get(ttsChannelId);
  setInterval(async ()=>{
    const messages = await ttsChannel.messages.fetch({limit:100});
    let date = (new Date()).getTime() - 5*60*1000;
    messages.each((m)=>{if (m.createdAt.getTime() < date) m.delete()});
  }, 1*60*1000);

  const voiceCh = await client.channels.cache.get(channelId);
  const voice = await voiceCh.join();

  let pending = Promise.resolve();
  let lastUser = 0;
  let currentlySpeaking = {};
  let currentStream;
  let speakCbs = [];

  const processCurrentlySpeaking = () => {
    let timeout = (new Date()).getTime() - 1*60*1000;
    for (const id of Object.keys(currentlySpeaking)) {
      if (currentlySpeaking[id].lastSeen < timeout) delete currentlySpeaking[id];
    }
    if (!Object.keys(currentlySpeaking).length && speakCbs.length) speakCbs.shift(1)();
  }

  voice.on('speaking', (user, {bitfield})=>{
    return; // FIXME https://github.com/discordjs/discord.js/issues/3524
    if (!user) user = {};
    if (user.bot) return;
    user.speaking = !!bitfield;
    let timeout = (new Date()).getTime() - 1*60*1000;

    currentlySpeaking[user.id] = {
      lastSeen: new Date().getTime(),
    };

    if(!user.speaking) delete currentlySpeaking[user.id];

    processCurrentlySpeaking();
  });

  const playVoice = clip => {
    return new Promise((res, rej) => {
      https.get(clip, (stream)=>{
        currentStream = voice.play(stream);
        currentStream.on('error', (e) => {console.error(e); res();});
        currentStream.on('warn', (e) => {console.warn(e);});
        currentStream.on('end', () => res());
        currentStream.on('finish', () => res());
      });
    });
  };

  client.on('message', async message => {
    if (!message.guild) return;
    //console.log(message);
    if (message.author.bot) return;
    if (message.channel.id != ttsChannelId) return;
    if (!message.content) return message.delete().catch(e=>{});
    if (message.content.startsWith('!') && !message.content.startsWith('!play')) return;
    if (selectiveMode && !(
      message.member &&
      message.member.voice &&
      message.member.voice.channelID === channelId
    )) return message.delete().catch(e=>{});

    if (!users[message.author.id]) users[message.author.id] = {};

    const settings = users[message.author.id];
    if (message.content.startsWith('>_')) {
      const parts = message.content.slice(2).split(' ');
      const cmd = commands[parts[0]];

      if (typeof cmd === 'function') {
        cmd(parts, message, {
          currentlySpeaking,
          filters,
          currentStream,
        });
        processCurrentlySpeaking();
      } else {
        const lang = parts[0].slice(0,2);
        users[message.author.id].lang = lang;
        message.reply('I\'ve set your language to '+lang);
        message.delete().catch(e=>{});
      }

      return;
    }

    for (const filter of Object.values(filters)) {
      while (filter.regex.test(message.content)) {
        let result = await filter.run(message, filter.regex.exec(message.content));
        if (result !== message.content) {
          message.content = result;
        } else {
          break;
        }
      }
    }

    const text = `${message.member.displayName.replace(/([A-Z][a-z])/g,' $1').replace(/(\d)/g,' $1')} says: ${message.content}`;
    console.log(text);

    if (!settings.prefix || settings.displayName != message.member.displayName) {
      settings.prefix = await googleTTS(`${message.member.displayName.replace(/([A-Z][a-z])/g,' $1').replace(/(\d)/g,' $1')} says:`, 'en', 1);
      settings.displayName = message.member.displayName;
    }
    const url = await googleTTS(`${message.content}`, settings.lang||'en', 1)
      .catch(e => googleTTS(`Text to speech error.`, 'en', 1));

    const oldpending = pending;
    pending = new Promise(async (res)=>{
      await oldpending;

      speakCbs.push(async ()=>{
        let say = settings.prefix;
        if (lastUser === message.author.id) {
          say = url;
        }
        await playVoice(say);
        if (lastUser === message.author.id) return res();
        await playVoice(url);
        res();
      });

      processCurrentlySpeaking();
    }).then(()=>{
      lastUser = message.author.id;
      message.react('✅').catch(e=>{});
      setTimeout(()=>message.delete().catch(e=>{}), 60*1000);
    });
  });
});

process
  .on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', reason.stack || reason);
    process.exit(1);
  }).on('uncaughtException', err => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
  });
