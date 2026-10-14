// Player Global Variables

let currentVideoTitle = '';
let currentEpisodeIndex = 0;
let currentEpisodes = [];
let currentEpisodeNames = [];
let episodesReversed = false;
let art = null;
let autoplayEnabled = true;
let videoHasEnded = false;
let adFilteringEnabled = true;
let progressSaveInterval = null;
let currentVideoUrl = '';
let currentEpisodeGroup = 0;

const EPISODES_PER_GROUP = 50;
