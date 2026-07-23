/**
 * Seeds the "Intro to Anna" playlist as the demo people see before they make
 * their own. Idempotent: re-running replaces the tracks rather than duplicating.
 *
 *   railway run node seed.js
 */

const crypto = require("crypto");
const { Pool } = require("pg");

const SLUG = "intro-to-anna";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("proxy.rlwy.net")
    ? { rejectUnauthorized: false }
    : false,
});

const KATIE =
  "Katie Gavin is the lead singer of the pop band MUNA, and she also has a folk-y album under her own name. One of my two favorite lyricists! I also admire how they use their public platform to uplift various social causes, call for community action, etc.";
const BLONDSHELL =
  "Up-and-coming indie rock singer; slowly cementing her spot on my list of favorite lyricists! I find her sound unique as a female rock vocalist.";
const FLETCHER = "Ah yes, Fletcher.";
const TOP =
  "A 2-person band made up of Tyler Joseph (singer + much more) and Josh Dun (drummer)";

const TRACKS = [
  ["The Baton", "Katie Gavin", "iX8pYFlzP9U", "Katie Gavin / MUNA", KATIE,
    "Starting with one off her solo project, also the newest of songs on this list. A meditation on mother-daughter relations."],
  ["Kind of Girl", "MUNA", "-m809HgeuLc", "Katie Gavin / MUNA", KATIE,
    "One of the best self-love-y songs IMO. Paved the way for Katie Gavin's solo project, why I was particularly excited & proud to hear she was releasing one."],
  ["I Know A Place", "MUNA", "lohR8TkGa_k", "Katie Gavin / MUNA", KATIE,
    "The OG banger, also a very uplifting message. MUNA was around for a while before they made it to the forefront of modern pop queer spaces, and this was one of their biggest songs years before they 'exploded'."],
  ["Silk Chiffon", "MUNA", "fhyk9rchC2c", "Katie Gavin / MUNA", KATIE,
    "The song that catapulted MUNA to the forefront of the queer pop scene, partially due to the fact that it features Phoebe Bridgers (very popular indie artist with strong fan base if you don't know her). MUNA got dropped from their label in 2020 and was picked up by Bridgers' label Saddest Factory Records a year later. Music video is a tribute to the queer cult classic movie But I'm a Cheerleader."],
  ["Salad", "Blondshell", "MOkPTtgdaW4", "Blondshell", BLONDSHELL,
    "Her best song IMO, Will always be one of her best songs. Listen to the lyrics, very powerful."],
  ["What's Fair", "Blondshell", "pvXT8BjqhUs", "Blondshell", BLONDSHELL,
    "A good representation of her overall sound and ability to write about life & relationships (in this case, her relationship with her mother)."],
  ["Model Rockets", "Blondshell", "q113Iv_YN3o", "Blondshell", BLONDSHELL,
    "My favorite off her newest album. Her bridges (on many of her songs) really get me. \u{1F64F}"],
  ["Sex with my ex", "FLETCHER", "qfavwT3gKn8", "FLETCHER", FLETCHER,
    "Perhaps the most visually shocking song on her EP that was all about her breakup with her ex, famous lesbian YouTuber Shannon Beveridge. She and Shannon created a music video to every song on the EP while they were broken up and living together (intentionally) during covid (yes, you read that right)."],
  ["Becky's So Hot", "FLETCHER", "R2GJqI9qgD8", "FLETCHER", FLETCHER,
    "The extremely controversial song that catapulted her career upward - Becky was Shannon's (not at all famous) new girlfriend (at the time) that Fletcher name drops. This video also gives a glimpse of Fletcher's live performances and intense fandom. I do not condone the song, it's exploitative (nor do I really like the song), but including for context. After this, there was 1-2 more albums about the same ex (ugh) and a whole saga involving Fletcher ending in featured on her ex's podcast to come full circle. Becky was the real hero here. As additional context, interestingly, Fletcher's interview / regular personality is very grounded and human forward while her artist persona historically has been lesbian chaos \u2014 something that seemed dissonant. All that drama apparently did not make Fletcher feel too good and her latest album (not included here) is purely self-reflective / slower, and she announced she would not be touring it right away / didn't know when she would or what she'd do next."],
  ["girls girls girls", "FLETCHER", "rzV9fgb-bsI", "FLETCHER", FLETCHER,
    "A reinterpretation / spin off / sample of Katy Perry's I kissed a girl but fr gay"],
  ["Ode to Sleep", "Twenty One Pilots", "2OnO3UXFZdE", "Twenty One Pilots", TOP,
    "I chose this video bc it shows the sound of their roots and progression from a small band playing to rooms of 12 people to thousands."],
  ["City Walls", "Twenty One Pilots", "5Ozjel72yjQ", "Twenty One Pilots", TOP,
    "Please do not feel pressured to watch this entire video \u{1F923}. I included this video because it closes a decade-long concept project that spans several albums. Between that first video and this one, t\u00f8p released 5 albums and a ton of corresponding media (a secret website, letters, music videos. etc.) that build out a story about a character Clancy trying to escape from a city called Dema, mirroring the struggles people can experience with mental health and trying to escape those patterns. A lot of the t\u00f8p fanbase was drawn to the band due to their lyrics / imagery / etc. directly addressing mental health struggles. The video contains callbacks to several lore-related videos from those earlier albums, and the audio ends with the beginning audio of the song heavydirtysoul, which essentially makes a full circle with the plot."],
  ["Oldies Station", "Twenty One Pilots", "bcnXSpcAk-w", "Twenty One Pilots", TOP,
    "Oldies Station is one of my favorite t\u00f8p songs and I think this acoustic rendition is beautiful. You'll see Tyler prefaces the song by saying a main purpose of it it was to give the fans an update on how he was \u2014 as I mentioned before a lot of the fanbase is very connected to the theme of mental health that runs through the band's music & they are well-versed in what Tyler has shared of his own experiences in the songs etc. Thus why his fans would be invested in that so much as to produce a song."],
  ["Downstairs", "Twenty One Pilots", "zcZMQZbPMxM", "Twenty One Pilots", TOP,
    "This is a really special song off the new album \u2013 when I attended Seasick's album release listening party, Tyler prefaced that this song was actually 14 years old and Josh (the drummer) had kept a demo of it on his computer after all those years and brought it up as an idea for this album. Stylistically, it sounds similar to their early stuff. Very special context for this (very recent!!) video \u2014 this is the first (and only so far) time they played it live. It is not on their tour setlist. This video was filmed at a private no-phones show hosted by a radio station while they were in LA last week to play some stadiums. You can tell how shocked and excited the fans were when they realized what song was starting. I think the video also really encapsulates the connection between the band and their fans, and the band's dynamic audience engagement."],
  ["HOT TO GO!", "Chappell Roan", "xaPNR-_Cfn0", "Chappell Roan", "",
    "A great encapsulation of her bubblegum pop aesthetic and energy mixed with Midwest Princess roots. If you didn't know, she's from the small town of Springfield, MO, where this music video is set."],
  ["Naked In Manhattan", "Chappell Roan", "QW2Alij7jlY", "Chappell Roan", "",
    "My fav! So fun so cute. Independently released in 2022 as she got dropped from her label in 2020 and before she signed with her producer Dan Nigro's Amusement Records in early 2023 \u2014 Dan Nigro also produces for Olivia Rodrigo. After she was dropped, she moved back to MO to save up $ and give it one last shot in LA (clearly that worked out). Her catapult to fame occurred in spring/summer 2024 after the momentum she built with the independent releases, opening for Olivia Rodrigo's world tour, appearing on NPR Tony Desk, promoting and releasing her single Good Luck, Babe!, and playing Coachella right after that. Fun fact \u2014 I saw her at Iron City (~1500 cap) in March of 2024 and it felt like a tidal wave before it took off. I then saw her 5 months later in a crowd of 100K people at lollapalooza in Chicago. Wild."],
  ["Kaleidoscope", "Chappell Roan", "imHkz5nD6gs", "Chappell Roan", "",
    "Gorgeous song, about her best friend that she was in love with who didn't share those feelings. If you like the slower sound, listen to California, which is basically about her journey struggling to make it as an artist and moving from Missouri to LA to do so."],
  ["Slow Burn", "Kacey Musgraves", "8NEmNGkj7_Y", "Kacey Musgraves", "",
    "\"grandma cried when I pierced my nose\" one of my fav song lyrics ever \u{1F923} makes me giggle every time"],
  ["Oh, What A World", "Kacey Musgraves", "1hwRe7scRiY", "Kacey Musgraves", "",
    "Gorgeous song about how beautiful the world is (and whatever man she's also singing about (?))."],
  ["The Architect", "Kacey Musgraves", "Tog63hCb7xs", "Kacey Musgraves", "",
    "Ms. Musgraves likes to meditate on life and I must say I quite enjoy that."],
];

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const randomId = (len) =>
  Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join("");
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

async function main() {
  const editToken = randomId(32);

  const existing = await pool.query("SELECT id FROM playlists WHERE slug = $1", [SLUG]);

  let playlistId;
  if (existing.rows[0]) {
    playlistId = existing.rows[0].id;
    await pool.query("DELETE FROM playlist_tracks WHERE playlist_id = $1", [playlistId]);
    console.log("Existing playlist found. Tracks cleared, edit key left as it was.");
  } else {
    const { rows } = await pool.query(
      `INSERT INTO playlists (slug, edit_token_hash, title, intro, creator_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        SLUG,
        hashToken(editToken),
        "Intro to Anna",
        "Six artists, twenty songs, and a note on each one about why that specific video is the one I picked.",
        "Keyona",
      ]
    );
    playlistId = rows[0].id;
    console.log("\n  Edit key (save this, it is shown once):\n");
    console.log("  " + editToken + "\n");
    console.log("  Edit link:  /e/" + SLUG + "#" + editToken + "\n");
  }

  for (let i = 0; i < TRACKS.length; i++) {
    const [title, artist, youtubeId, artistName, artistContext, commentary] = TRACKS[i];
    await pool.query(
      `INSERT INTO playlist_tracks
         (playlist_id, position, title, artist, youtube_id, artist_name, artist_context, commentary, contributor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [playlistId, i + 1, title, artist, youtubeId, artistName, artistContext, commentary, "Keyona"]
    );
  }

  console.log(`Seeded ${TRACKS.length} tracks into /p/${SLUG}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
