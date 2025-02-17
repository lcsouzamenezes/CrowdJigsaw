const mongoose=require("mongoose");

var ActionSchema=new mongoose.Schema({
        round_id: { type: Number, required: true, index:true },  
        time: { type: Number,required: true, index:true }, // formatted time, e.g. 2017-10-31 14:00:20
        player_name: { type: String }, // playername
        links_size: { type: Object}, // [{x, y, tag, size, behinted}]
});

console.log('[OK] Action Schema Created.');

exports.Action = mongoose.model('Action', ActionSchema);