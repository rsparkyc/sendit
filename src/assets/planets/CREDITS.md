# Planet and moon textures: sources, licences, processing

Every texture in this directory was made by `scripts/make-planet-textures.py` from the source
listed below. The same table is published on the site at `/credits.html` (linked from the viewer).

**Licence summary.** USGS and NASA Goddard (Visible Earth, Scientific Visualization Studio) products
are works of the U.S. Government and in the public domain. The Jupiter map (PIA07782) and the
Triton map (PIA18668) are NASA Photojournal images, released for public use under NASA's media
usage guidelines and the JPL image use policy with the credit line given; no Creative Commons or
non-commercial terms apply. Rotation constants are from NAIF pck00011 (public domain, NASA/JPL).

**Processing, all bodies.** Decoded as images only (nothing executed), box-filtered down, rolled so
that the left edge is 0 deg and east longitude increases to the right (planetocentric, east-positive,
0-360), never-imaged pixels (value 0) replaced by one flat neutral tone (the mean of the imaged
pixels), resampled to the tiers below and encoded as WebP. No detail was added, painted or
synthesised. Low tier: 512 x 256. High tier: 2048 x 1024 (1024 x 512 for Tethys, Dione, Rhea and
Iapetus), WebP quality 80 (Tethys/Dione/Iapetus/Mercury 70, Rhea 75).

**Longitude conventions.** The source convention is taken from each product's ISIS label
(`CenterLongitude`, `LongitudeDirection`, `UpperLeftCornerX`): for every map, image columns run
from west to east, so an east-positive map starts at `CenterLongitude + UpperLeftCornerX / R` and a
west-positive one at `-(CenterLongitude - UpperLeftCornerX / R)` deg east. The output always starts
at 0 deg east. The renderer places longitude 0 on the IAU prime meridian (src/app/body-rotation.ts).

| Body | Source (URL) | Author / credit | Licence | Source convention | Gaps / notes |
|---|---|---|---|---|---|
| Earth | Blue Marble Next Generation w/ topography and bathymetry, April 2004, 5400 x 2700: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/april/world.topo.bathy.200404.3x5400x2700.jpg (page: https://visibleearth.nasa.gov/images/73776) | NASA Earth Observatory / Reto Stockli, NASA GSFC | Public domain (NASA) | -180 to 180, east-positive, geodetic latitude | none |
| Earth (night lights) | Black Marble 2016, 0.1 deg, 3600 x 1800: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg | NASA Earth Observatory / Joshua Stevens, Miguel Roman, NASA GSFC | Public domain (NASA) | -180 to 180, east-positive | one tier, 1024 x 512, shown only on the night side |
| Moon | CGI Moon Kit, LROC WAC colour mosaic with poles, 4096 x 2048: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif (page: https://svs.gsfc.nasa.gov/4720) | NASA Scientific Visualization Studio, Ernie Wright; LRO/LROC (NASA/GSFC/Arizona State University) | Public domain (NASA SVS) | -180 to 180, east-positive (0 deg at centre) | none |
| Mercury | MESSENGER MDIS global mosaic 250 m (2013): https://planetarymaps.usgs.gov/mosaic/Mercury_MESSENGER_mosaic_global_250m_2013.tif | USGS Astrogeology; NASA/JHUAPL/Carnegie Institution of Washington | Public domain (USGS) | Equirectangular, CenterLongitude 0, PositiveEast, planetocentric | none (greyscale) |
| Mars | Viking MDIM 2.1 colour mosaic 925 m: https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif | USGS Astrogeology; NASA Viking | Public domain (USGS) | Simple cylindrical, CenterLongitude 0, PositiveEast, planetocentric | colour is the USGS Viking colour product |
| Jupiter | Cassini's Best Maps of Jupiter, cylindrical map, PIA07782, 3601 x 1801: https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.jpg (page: https://science.nasa.gov/photojournal/cassinis-best-maps-of-jupiter-cylindrical-map/) | NASA/JPL/Space Science Institute | NASA Photojournal, public use with credit | planetocentric latitude, 360 deg of longitude; the longitude origin is not stated by the source, the map is placed with its left edge at 0 deg | Clouds drift relative to System III, so feature longitudes (e.g. the Great Red Spot) are those of December 2000, not of the simulated date; belts and zones are at the right latitudes |
| Io | Galileo SSI / Voyager global colour merge 1 km: https://planetarymaps.usgs.gov/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif | USGS Astrogeology; NASA Galileo, Voyager | Public domain (USGS) | Simple cylindrical, CenterLongitude 0, PositiveWest, planetocentric | none |
| Europa | Voyager / Galileo SSI global mosaic 500 m: https://planetarymaps.usgs.gov/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif | USGS Astrogeology; NASA Galileo, Voyager | Public domain (USGS) | Simple cylindrical, CenterLongitude 180, PositiveWest, planetocentric | 4.3% never imaged: neutral fill |
| Ganymede | Voyager / Galileo SSI global colour mosaic 1.4 km: https://planetarymaps.usgs.gov/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif | USGS Astrogeology; NASA Galileo, Voyager | Public domain (USGS) | Equirectangular, CenterLongitude 180, PositiveEast, planetocentric | 3.6% neutral fill |
| Callisto | Voyager / Galileo SSI global mosaic 1 km: https://planetarymaps.usgs.gov/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif | USGS Astrogeology; NASA Galileo, Voyager | Public domain (USGS) | Simple cylindrical, CenterLongitude 180, PositiveWest, planetocentric | 3.8% neutral fill |
| Titan | Cassini ISS global mosaic 4 km (P19658): https://planetarymaps.usgs.gov/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif | USGS Astrogeology; NASA/JPL/Space Science Institute | Public domain (USGS) | Equirectangular, CenterLongitude 180, PositiveWest, planetocentric | near-infrared surface view through the haze, not Titan's orange visible appearance |
| Tethys | Cassini global mosaic 293 m: https://planetarymaps.usgs.gov/mosaic/Tethys_Cassini_mosaic_global_293m.tif | USGS Astrogeology; NASA/JPL/Space Science Institute | Public domain (USGS) | Equirectangular, CenterLongitude 0, PositiveEast, planetocentric | none |
| Dione | Cassini / Voyager global mosaic 154 m: https://planetarymaps.usgs.gov/mosaic/Dione_Cassini_Voyager_mosaic_global_154m.tif | USGS Astrogeology; NASA Cassini, Voyager | Public domain (USGS) | Equirectangular, CenterLongitude 0, PositiveEast, planetocentric | 0.1% neutral fill |
| Rhea | Cassini / Voyager global mosaic 417 m: https://planetarymaps.usgs.gov/mosaic/Rhea_Cassini_Voyager_mosaic_global_417m.tif | USGS Astrogeology; NASA Cassini, Voyager | Public domain (USGS) | Simple cylindrical, CenterLongitude 180, PositiveWest, planetocentric | none |
| Iapetus | Cassini / Voyager global mosaic 783 m: https://planetarymaps.usgs.gov/mosaic/Iapetus_Cassini_Voyager_mosaic_global_783m.tif | USGS Astrogeology; NASA Cassini, Voyager | Public domain (USGS) | Simple cylindrical, CenterLongitude 0, PositiveWest, planetocentric | none |
| Triton | Voyager 2 global colour mosaic 600 m (PIA18668): https://planetarymaps.usgs.gov/mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif | Paul Schenk, Lunar and Planetary Institute; NASA/JPL (PIA18668), distributed by USGS | NASA Photojournal / USGS, public use with credit | Equirectangular, CenterLongitude 0, PositiveEast, planetocentric | Voyager 2 saw mainly the southern hemisphere; the source already fills unseen areas with flat tones, and the remaining 38.6% no-data pixels got our neutral fill |
| Pluto | New Horizons LORRI/MVIC global mosaic 300 m (July 2017): https://planetarymaps.usgs.gov/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | USGS Astrogeology; NASA/JHUAPL/SwRI | Public domain (USGS) | Equirectangular, CenterLongitude 180, PositiveEast, planetographic (= planetocentric on a sphere); north = IAU positive pole | 31.9% (the southern hemisphere in polar night in 2015) neutral fill |
| Charon | New Horizons LORRI/MVIC global mosaic 300 m (July 2017): https://planetarymaps.usgs.gov/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | USGS Astrogeology; NASA/JHUAPL/SwRI | Public domain (USGS) | Simple cylindrical, CenterLongitude 0, PositiveEast, planetographic (sphere) | 33.9% neutral fill |

The `planetarymaps.usgs.gov/mosaic/...` URLs redirect to the USGS Astrogeology bucket
`https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/...`, which is where the files were
fetched from; each has an ISIS `.lbl` label beside it with the map projection.

## Not textured (flat colour), and why

- **Sun**: no public-domain equirectangular photosphere map; it stays an unlit emissive disc.
- **Venus**: the only global maps are Magellan radar mosaics of the surface; Venus as seen is
  featureless cloud, so a radar map would misrepresent its appearance.
- **Saturn**: no public-domain global cylindrical map of the planet was found (only regional
  mosaics and non-map portraits). The rings are drawn from measured ring boundaries (see below).
- **Uranus, Neptune**: no public-domain global maps (the visible discs are nearly featureless;
  the maps in circulation are artistic or have unstated licences).
- **Ariel, Umbriel, Titania, Oberon**: the Voyager 2 maps found online (JPL Solar System
  Simulator, 1440 x 720) state no licence, and no USGS public-domain release of global mosaics
  was found; per the licensing rule they are left as coloured spheres.

## Saturn's rings (schematic, not an image)

Ring and gap boundaries from the NASA NSSDC Saturnian Rings Fact Sheet
(https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html): C ring 74,658-92,000 km,
B ring 92,000-117,580 km, Cassini Division 117,580-122,170 km, A ring 122,170-136,775 km with the
Encke gap at 133,589 km (325 km wide), F ring at 140,180 km. Each region has one representative
opacity and brightness (src/app/saturn-rings.ts); finer structure is not drawn.

## Rotation constants

src/physics/data/iau-rotation.json, generated by `scripts/gen-iau-rotation.py` from
https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc (IAU WGCCRE 2015, Archinal et
al. 2018), including the periodic terms the kernel lists.
