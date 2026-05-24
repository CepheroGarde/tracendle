Voicedle voice clips (2 seconds max each)

Place one MP3 per Umamusume character using this naming pattern:
  Special_Week.mp3
  Silence_Suzuka.mp3
  (spaces in character names become underscores)

Paths are listed in voicedle.json at the project root.
Regenerate voicedle.json after roster changes:
  node -e "const u=require('./data.json');const h=u.map(x=>({name:x.name,image:x.image,voice:'audio/voices/'+x.name.replace(/ /g,'_')+'.mp3'}));require('fs').writeFileSync('voicedle.json',JSON.stringify(h,null,2));"
