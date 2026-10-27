// Words for readable link slugs ("quiet-otter-41"). Curated to be read aloud,
// typed from memory and pasted without surprises: lowercase a-z, three to
// eight letters, common, non-offensive, one obvious spelling, and no
// homophones or heteronyms (no bear/bare, tail/tale, sea/see, lead, wind),
// so a link said over a call is typed correctly the first time.
// readable-words.test.mjs enforces the shape and the homophone blocklist.
export const ADJECTIVES=Object.freeze(`
able agile alert alive amber ample azure bold brave breezy bright brisk broad busy calm candid
carefree caring cheery chief civic clean clear clever cloudy cosmic crisp curly curious dapper daring dashing
deep deft dewy direct dreamy driven dusty eager early earnest easy elated elder elegant epic equal
even exact expert famous fancy fast fearless festive fiery first fit fleet fluent fluffy flying focused
fond frank free fresh friendly frosty frugal fuzzy gentle gifted glad gleaming global glossy golden good
graceful grand grassy handy happy hardy hasty hearty helpful heroic hidden honest hopeful humble icy ideal
inner jolly jovial joyful juicy keen kind kindly large lasting lavish leafy legal level light likely
lively local lofty logical loyal lucky lunar lush magic major mellow mighty mild minty misty modern
modest mossy moving musical narrow native neat nimble noble normal novel open optimal orange organic outer
peaceful peppy perfect pink placid playful plucky plush polar polite popular precise prime proper proud punctual
pure purple quick quiet quirky radiant rapid ready regal rich rocky round royal rugged rustic safe
salty sandy savvy scarlet secret serene sharp shiny silent silky silver simple sleek sleepy slender smart
smooth snappy snowy snug social soft solar solid sonic sparkly speedy spicy spry stable steady sterling
stoic stout strong sturdy subtle sunny super superb swift tender thrifty tidy tiny tough tranquil trusty
tuned upbeat urban useful valid vast velvet vivid warm wavy wild willing witty worthy young zany
zesty zippy airy ancient arctic balmy beaming blissful bouncy bubbly buoyant classic cobalt comfy crafty creamy
crimson dainty dazzling dynamic electric emerald endless fabulous faithful fertile flexible floral fragrant gallant genial genuine
glowing gracious grateful hazy hefty hopping humming indigo jaunty jazzy jubilant kinetic laughing lilac limber lucid
luminous magenta majestic mature merciful meteoric mindful nautical neon nifty olive opal orbital pastel pearly perky
poetic polished prompt quaint radical relaxed restful robust roomy rosy ruby rural scenic seasoned sensible shimmery
sincere skillful smiling soaring spirited splendid springy starry stellar sublime sugary sunlit supple tactful tasty teal
thankful timely tireless toasty topaz tropical true tuneful twinkly unique upright vibrant vintage violet virtual vocal
wakeful wiry wondrous woven zealous
`.trim().split(/\s+/));

export const NOUNS=Object.freeze(`
otter badger beaver bison bobcat camel cobra condor cougar coyote crane crow cricket dingo dolphin donkey
eagle egret falcon ferret finch fox gecko gibbon goat goose gopher heron hippo hornet husky ibis
iguana impala jackal jaguar kitten koala lemur leopard lion lizard llama lobster magpie mallard manatee marmot
meerkat mink mole moth mouse newt ocelot octopus oriole osprey ostrich owl oyster panda panther parrot
pelican penguin pigeon pony possum puffin puma python quail rabbit raccoon raven robin salmon sardine seal
shark sheep shrimp skunk sloth snail sparrow spider squid stork swan tiger toucan trout tuna turkey
turtle viper walrus wasp weasel wombat wren yak zebra cat dog elk emu hen ram kiwi
hawk lark bunny chick colt calf cub fawn foal lamb piglet puppy beagle poodle corgi collie
terrier mustang bronco buffalo gazelle giraffe hamster hedgehog krill marlin minnow orca pike perch plover sturgeon
swallow thrush warbler wolf beetle firefly ladybug mantis cicada acorn aspen autumn bamboo basin birch blossom
bloom branch breeze brook bush canyon cactus cedar cliff clover cloud coast comet coral cosmos cove
crater crystal cypress daisy dale delta dune dusk ember fern field flame forest frost galaxy garden
geyser glacier glade glen grove gulf hazel heath hill island ivy jungle lagoon lake lantern laurel
lava leaf lily lotus magnet maple marsh meadow mesa meteor moon moss mountain nebula oak oasis
orbit orchid palm pebble petal pine planet pond poppy prairie rainbow rapids reef ridge river rock
sage shore sky snow spring spruce star stone stream summit sunset swamp thicket thunder timber trail
tree tulip tundra valley willow aurora horizon ripple glow spark prism pollen sapling seedling thistle solstice
zenith vortex anchor anvil arrow atlas badge banjo banner barrel basket beacon bicycle blanket bottle bucket
button cabin camera candle canoe castle chalk chimney cider clock compass cookie crayon crown cup cushion
drum easel engine fiddle flag flute fountain gadget garnet gem guitar hammer harp helmet hinge igloo
jacket jar kayak kettle kite ladder lamp lens locket mantle marble mirror mitten mosaic needle notebook
oven paddle paint pencil piano pillow pixel quill quilt radio raft ribbon rocket saddle satchel scarf
scroll shovel silo sled slipper spoon statue stencil sweater table teapot ticket toaster token torch tower
trophy trumpet tuba tunnel umbrella vase violin wagon wallet whistle window yarn zipper bridge cable chisel
crate dial domino funnel globe goblet hammock kazoo lever ledger mallet nickel padlock parcel pendant plank
pocket pulley puzzle rudder shield socket spindle spool sprocket stapler tablet thimble tripod trolley valve wrench
widget beaker bobbin bracket buckle carton comb cradle fork goggles jigsaw ladle napkin pitcher ruler skillet
spatula sponge stool tongs trowel whisk apple apricot bagel banana basil biscuit brownie butter cabbage cake
candy cashew celery cherry cocoa coconut coffee cracker cumin curry dumpling fig garlic ginger grape guava
honey lemon lentil lime mango melon muffin mustard noodle nutmeg onion papaya peach peanut pecan pepper
pickle pizza popcorn potato pretzel pumpkin radish raisin salsa scone sesame sorbet soup spinach sugar taco
toffee tomato truffle turnip vanilla waffle walnut almond avocado cheddar cheese crumpet falafel granola hazelnut kale
mocha nacho oatmeal pancake pasta pastry pudding ramen risotto saffron tofu wasabi arcade atrium attic avenue
bakery balcony campus canal chapel citadel city corner cottage depot diner farm garage gallery hotel kiosk
library lobby market museum office orchard palace park pavilion plaza porch quarry ranch school studio temple
terrace village villa workshop echo legend melody riddle saga sonnet tempo verse fable ballad chorus harmony
lyric motif opera poem sketch voyage journey quest signal robot pilot captain scout ranger sailor wizard
pirate ninja abacus album alcove algebra amulet antenna apron aquarium archer armada asteroid axle backpack ballot
balloon bandana barley baton beanbag bedrock bench biplane blender blimp bouquet bracelet brick broom bubble bugle
bungalow burrito calendar caliper camper canopy capsule caravan cargo carousel cassette catapult cauldron cavern ceramic chariot
charm chess chestnut cinema circuit clarinet cocoon compost concert console cookbook copper corridor costume cotton crescent
croquet crouton cupcake cyclone diamond dinghy diploma disco dragon dynamo eclipse elevator emblem envelope eraser estuary
fabric feather festival filament flannel flipper fossil fresco frisbee galleon garland gazebo glider gondola gravel griddle
hairpin harness haystack headband hilltop hologram hydrant icicle inkwell iris jasmine jetty jukebox keystone kiln kingdom
lasso lattice lemonade limerick lollipop lunchbox macaroni magnolia mandolin marigold marina mascot monsoon moonbeam mortar mosquito
muffler nectar nest nomad nugget obelisk oboe odyssey origami outpost paddock pagoda palette panorama papyrus parasol
parka passport peacock pendulum peony pinwheel planter platypus podium polka pompom postcard pyramid quasar quokka radar
rafter railway rattle recipe relic rhubarb rickshaw rooftop rosemary sandbox sandal scaffold scooter seashell sequoia shamrock
shuttle skylight skyline snorkel sombrero sparkler spyglass starfish stardust sundial tadpole tapestry teacup thermos tinsel toboggan
tornado tortoise trellis tricycle trinket tugboat turbine ukulele unicorn vector veranda vessel viaduct vinyl volcano wanderer
windmill wishbone woodland yacht yodel zeppelin
`.trim().split(/\s+/));

// The words these lists deliberately leave out. Each is a homophone,
// heteronym or ambiguous spelling of a word someone might hear instead.
export const EXCLUDED_WORDS=Object.freeze(`
bear bare deer dear hare hair mail male knight night sun son sea see flower flour pear pair plane
plain rose rows rain reign road rode tail tale toe tow week weak wood would hour our knot not eye
bee ant aunt berry bury steak stake peak peek pole poll sail sale sole soul stair stare waist waste
wait weight whale wail board bored boulder bolder cell sell cent scent chord cord dew due flea flee
flu flew fir fur heal heel hall haul isle aisle lead mane main meat meet oar ore pain pane peace
piece plum plumb prey pray reed ring wring root route seam seem sew sow sight site steal steel
sweet suite tea tee tide tied vane vein way weigh yolk yoke bass bow wind tear dove close beach
beech brake break bread bred chili chilly creek creak doe dough flair flare foul fowl gait gate
horse hoarse lynx links maize maze time thyme whine wine ball bawl carrot karat heart hart weather
whether team teem cellar seller border boarder world whirled block bloc dock doc core corps step
steppe story storey seed cede sign sine surf serf dam damn eight ate beet beat bell belle claws
clause new knew leek leak lute loot mast massed pea pee mite might air heir canvas canvass cannon
canon bazaar bizarre harbor harbour cozy cosy gray grey donut doughnut yogurt yoghurt plateau
savanna fjord theater theatre desert dessert idle idol mist missed patient quartz tapir taper wave
waive current currant hail hale merry marry woolly lychee gauge cypher rhyme rhythm symbol cymbal
hostel hostile inn plate pail paw dagger hatchet sickle
`.trim().split(/\s+/));
