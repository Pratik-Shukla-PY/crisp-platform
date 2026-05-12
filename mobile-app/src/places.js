// ── CRISP Offline Places Database ─────────────────────────────────────────────
// Bundled city data for instant offline autocomplete — no network needed.
// Format: [name, region, country, lat, lng]
// ~700 cities: all capitals + crisis-region coverage + major cities globally.
// Cached by service worker — works on first load, forever after.

const CRISP_CITIES = [
// ── Africa ────────────────────────────────────────────────────────────────────
["Addis Ababa","Oromia","Ethiopia",9.0249,38.7469],
["Nairobi","Nairobi","Kenya",-1.2864,36.8172],
["Kampala","Central","Uganda",0.3163,32.5822],
["Kigali","Kigali","Rwanda",-1.9706,30.1044],
["Dar es Salaam","Dar es Salaam","Tanzania",-6.7924,39.2083],
["Dodoma","Dodoma","Tanzania",-6.1722,35.7395],
["Lusaka","Lusaka","Zambia",-15.4167,28.2833],
["Harare","Harare","Zimbabwe",-17.8292,31.0522],
["Lilongwe","Central","Malawi",-13.9669,33.7873],
["Maputo","Maputo","Mozambique",-25.9686,32.5804],
["Beira","Sofala","Mozambique",-19.8437,34.8384],
["Mombasa","Coast","Kenya",-4.0435,39.6682],
["Kisumu","Nyanza","Kenya",-0.0917,34.7679],
["Goma","North Kivu","DR Congo",-1.6796,29.2286],
["Bukavu","South Kivu","DR Congo",-2.4977,28.8353],
["Butembo","North Kivu","DR Congo",0.1382,29.2926],
["Kinshasa","Kinshasa","DR Congo",-4.3317,15.3139],
["Lubumbashi","Katanga","DR Congo",-11.6609,27.4794],
["Mbuji-Mayi","Kasai","DR Congo",-6.1498,23.5898],
["Kisangani","Tshopo","DR Congo",0.5153,25.1982],
["Brazzaville","Pool","Republic of Congo",-4.2634,15.2429],
["Pointe-Noire","Kouilou","Republic of Congo",-4.7761,11.8635],
["Libreville","Estuaire","Gabon",0.3901,9.4544],
["Yaoundé","Centre","Cameroon",3.8667,11.5167],
["Douala","Littoral","Cameroon",4.0511,9.7679],
["Maroua","Far North","Cameroon",10.5917,14.3167],
["Bangui","Ombella-M'Poko","Central African Republic",4.3947,18.5582],
["N'Djamena","Chari-Baguirmi","Chad",12.1048,15.0445],
["Abéché","Ouaddaï","Chad",13.8296,20.8329],
["Niamey","Niamey","Niger",13.5137,2.1098],
["Agadez","Agadez","Niger",16.9742,7.9878],
["Ouagadougou","Kadiogo","Burkina Faso",12.3647,-1.5332],
["Bobo-Dioulasso","Hauts-Bassins","Burkina Faso",11.1771,-4.2979],
["Bamako","Bamako","Mali",12.6392,-8.0029],
["Timbuktu","Tombouctou","Mali",16.7667,-3.0026],
["Gao","Gao","Mali",16.2667,-0.0500],
["Mopti","Mopti","Mali",14.4974,-4.1970],
["Dakar","Dakar","Senegal",14.6937,-17.4441],
["Ziguinchor","Ziguinchor","Senegal",12.5681,-16.2719],
["Banjul","Banjul","Gambia",13.4531,-16.5775],
["Bissau","Bissau","Guinea-Bissau",11.8636,-15.5977],
["Conakry","Conakry","Guinea",9.5370,-13.6773],
["Kindia","Kindia","Guinea",10.0433,-12.8658],
["Freetown","Western Area","Sierra Leone",8.4657,-13.2317],
["Bo","Southern","Sierra Leone",7.9647,-11.7383],
["Monrovia","Montserrado","Liberia",6.3106,-10.8047],
["Abidjan","Lagunes","Côte d'Ivoire",5.3545,-4.0018],
["Yamoussoukro","Vallée du Bandama","Côte d'Ivoire",6.8276,-5.2893],
["Bouaké","Vallée du Bandama","Côte d'Ivoire",7.6833,-5.0333],
["Accra","Greater Accra","Ghana",5.5502,-0.2174],
["Kumasi","Ashanti","Ghana",6.6885,-1.6244],
["Tamale","Northern","Ghana",9.4075,-0.8533],
["Lomé","Maritime","Togo",6.1375,1.2123],
["Cotonou","Littoral","Benin",6.3654,2.4183],
["Porto-Novo","Ouémé","Benin",6.4969,2.6289],
["Lagos","Lagos","Nigeria",6.4541,3.3947],
["Abuja","Federal Capital","Nigeria",9.0579,7.4951],
["Kano","Kano","Nigeria",12.0000,8.5167],
["Ibadan","Oyo","Nigeria",7.3875,3.8964],
["Kaduna","Kaduna","Nigeria",10.5222,7.4383],
["Maiduguri","Borno","Nigeria",11.8333,13.1500],
["Port Harcourt","Rivers","Nigeria",4.7780,7.0134],
["Enugu","Enugu","Nigeria",6.4400,7.4981],
["Sokoto","Sokoto","Nigeria",13.0622,5.2339],
["Zaria","Kaduna","Nigeria",11.0803,7.6886],
["Khartoum","Khartoum","Sudan",15.5007,32.5599],
["Omdurman","Khartoum","Sudan",15.6445,32.4803],
["Port Sudan","Red Sea","Sudan",19.6158,37.2164],
["El Fasher","North Darfur","Sudan",13.6279,25.3508],
["El Geneina","West Darfur","Sudan",13.4500,22.4500],
["Juba","Central Equatoria","South Sudan",4.8594,31.5713],
["Malakal","Upper Nile","South Sudan",9.5333,31.6500],
["Wau","Western Bahr el Ghazal","South Sudan",7.7004,27.9953],
["Yambio","Western Equatoria","South Sudan",4.5700,28.3800],
["Asmara","Maekel","Eritrea",15.3229,38.9251],
["Djibouti","Djibouti","Djibouti",11.5886,43.1451],
["Mogadishu","Banadir","Somalia",2.0469,45.3182],
["Hargeisa","Woqooyi Galbeed","Somalia",9.5597,44.0650],
["Kismayo","Jubaland","Somalia",-0.3582,42.5454],
["Baidoa","Bay","Somalia",3.1180,43.6486],
["Beledweyne","Hiiraan","Somalia",4.7381,45.2044],
["Praia","Santiago","Cape Verde",14.9215,-23.5087],
["Malabo","Bioko Norte","Equatorial Guinea",3.7500,8.7833],
["São Tomé","São Tomé","São Tomé and Príncipe",0.3365,6.7273],
["Luanda","Luanda","Angola",-8.8383,13.2344],
["Cabinda","Cabinda","Angola",-5.5500,12.2000],
["Gaborone","South-East","Botswana",-24.6282,25.9231],
["Windhoek","Khomas","Namibia",-22.5597,17.0832],
["Maseru","Maseru","Lesotho",-29.3167,27.4833],
["Mbabane","Hhohho","Eswatini",-26.3186,31.1410],
["Pretoria","Gauteng","South Africa",-25.7479,28.2293],
["Cape Town","Western Cape","South Africa",-33.9258,18.4232],
["Johannesburg","Gauteng","South Africa",-26.2041,28.0473],
["Durban","KwaZulu-Natal","South Africa",-29.8587,31.0218],
["Antananarivo","Analamanga","Madagascar",-18.9137,47.5361],
["Moroni","Grande Comore","Comoros",-11.7022,43.2551],
["Port Louis","Port Louis","Mauritius",-20.1654,57.4896],
["Victoria","Mahé","Seychelles",-4.6267,55.4507],
["Bata","Litoral","Equatorial Guinea",1.8639,9.7742],
["Cairo","Cairo","Egypt",30.0444,31.2357],
["Alexandria","Alexandria","Egypt",31.2001,29.9187],
["Aswan","Aswan","Egypt",24.0908,32.8998],
["Tripoli","Tripoli","Libya",32.8752,13.1875],
["Benghazi","Benghazi","Libya",32.1167,20.0667],
["Tunis","Tunis","Tunisia",36.8189,10.1658],
["Algiers","Algiers","Algeria",36.7372,3.0865],
["Oran","Oran","Algeria",35.6969,-0.6331],
["Rabat","Rabat-Salé","Morocco",34.0209,-6.8416],
["Casablanca","Casablanca-Settat","Morocco",33.5731,-7.5898],
["Marrakech","Marrakech-Safi","Morocco",31.6295,-7.9811],
["Fès","Fès-Meknès","Morocco",34.0181,-5.0078],
["Nouakchott","Nouakchott","Mauritania",18.0735,-15.9582],
["Mamoudzou","Mayotte","France",-12.7806,45.2278],
["Saint-Denis","Réunion","France",-20.8789,55.4481],
// ── Middle East / MENA ────────────────────────────────────────────────────────
["Kabul","Kabul","Afghanistan",34.5281,69.1723],
["Kandahar","Kandahar","Afghanistan",31.6129,65.7372],
["Herat","Herat","Afghanistan",34.3529,62.2040],
["Mazar-i-Sharif","Balkh","Afghanistan",36.7069,67.1106],
["Kunduz","Kunduz","Afghanistan",36.7283,68.8682],
["Jalalabad","Nangarhar","Afghanistan",34.4415,70.4360],
["Baghdad","Baghdad","Iraq",33.3406,44.4009],
["Mosul","Nineveh","Iraq",36.3350,43.1189],
["Basra","Basra","Iraq",30.5085,47.7804],
["Erbil","Erbil","Iraq",36.1901,44.0091],
["Kirkuk","Kirkuk","Iraq",35.4681,44.3922],
["Najaf","Najaf","Iraq",31.9935,44.3300],
["Fallujah","Al Anbar","Iraq",33.3534,43.7786],
["Ramadi","Al Anbar","Iraq",33.4258,43.2996],
["Sinjar","Nineveh","Iraq",36.3256,41.8696],
["Beirut","Beirut","Lebanon",33.8869,35.5131],
["Tripoli","North","Lebanon",34.4367,35.8497],
["Sidon","South","Lebanon",33.5606,35.3714],
["Damascus","Damascus","Syria",33.5102,36.2913],
["Aleppo","Aleppo","Syria",36.2021,37.1343],
["Homs","Homs","Syria",34.7324,36.7137],
["Latakia","Latakia","Syria",35.5317,35.7914],
["Deir ez-Zor","Deir ez-Zor","Syria",35.3352,40.1394],
["Raqqa","Raqqa","Syria",35.9521,39.0193],
["Idlib","Idlib","Syria",35.9302,36.6344],
["Sana'a","Sana'a","Yemen",15.3694,44.1910],
["Aden","Aden","Yemen",12.7797,45.0367],
["Taiz","Taiz","Yemen",13.5796,44.0219],
["Hudaydah","Hudaydah","Yemen",14.7980,42.9511],
["Marib","Marib","Yemen",15.4686,45.3225],
["Gaza City","Gaza","Palestine",31.5017,34.4668],
["Khan Yunis","Khan Yunis","Palestine",31.3421,34.3062],
["Rafah","Rafah","Palestine",31.2881,34.2458],
["Ramallah","Ramallah","Palestine",31.9038,35.2040],
["Hebron","Hebron","Palestine",31.5236,35.0958],
["Nablus","Nablus","Palestine",32.2253,35.2574],
["Jenin","Jenin","Palestine",32.4611,35.2961],
["Amman","Amman","Jordan",31.9539,35.9106],
["Zarqa","Zarqa","Jordan",32.0609,36.0875],
["Irbid","Irbid","Jordan",32.5556,35.8478],
["Zaatari","Mafraq","Jordan",32.2944,36.3347],
["Kuwait City","Al Asimah","Kuwait",29.3759,47.9774],
["Manama","Capital","Bahrain",26.2154,50.5832],
["Doha","Doha","Qatar",25.2854,51.5310],
["Abu Dhabi","Abu Dhabi","UAE",24.4539,54.3773],
["Dubai","Dubai","UAE",25.2048,55.2708],
["Muscat","Muscat","Oman",23.5880,58.3829],
["Riyadh","Riyadh","Saudi Arabia",24.7136,46.6753],
["Jeddah","Makkah","Saudi Arabia",21.4858,39.1925],
["Mecca","Makkah","Saudi Arabia",21.3891,39.8579],
["Medina","Madinah","Saudi Arabia",24.5247,39.5692],
["Tehran","Tehran","Iran",35.6892,51.3890],
["Mashhad","Razavi Khorasan","Iran",36.2605,59.6168],
["Isfahan","Isfahan","Iran",32.6546,51.6680],
["Tabriz","East Azerbaijan","Iran",38.0800,46.2919],
["Shiraz","Fars","Iran",29.5918,52.5836],
["Ankara","Ankara","Turkey",39.9334,32.8597],
["Istanbul","Istanbul","Turkey",41.0082,28.9784],
["Izmir","İzmir","Turkey",38.4237,27.1428],
["Nicosia","Nicosia","Cyprus",35.1676,33.3736],
["Tel Aviv","Tel Aviv","Israel",32.0853,34.7818],
["Jerusalem","Jerusalem","Israel",31.7683,35.2137],
// ── South / Central Asia ──────────────────────────────────────────────────────
["Islamabad","Islamabad","Pakistan",33.7294,73.0931],
["Karachi","Sindh","Pakistan",24.8607,67.0011],
["Lahore","Punjab","Pakistan",31.5497,74.3436],
["Rawalpindi","Punjab","Pakistan",33.6007,73.0679],
["Faisalabad","Punjab","Pakistan",31.4180,73.0790],
["Peshawar","Khyber Pakhtunkhwa","Pakistan",34.0150,71.5805],
["Quetta","Balochistan","Pakistan",30.1798,66.9750],
["Multan","Punjab","Pakistan",30.1978,71.4711],
["Dhaka","Dhaka","Bangladesh",23.8103,90.4125],
["Chittagong","Chittagong","Bangladesh",22.3569,91.7832],
["Sylhet","Sylhet","Bangladesh",24.8949,91.8687],
["Cox's Bazar","Chittagong","Bangladesh",21.4272,92.0058],
["Kathmandu","Bagmati","Nepal",27.7172,85.3240],
["Pokhara","Gandaki","Nepal",28.2096,83.9856],
["Colombo","Western","Sri Lanka",6.9271,79.8612],
["Jaffna","Northern","Sri Lanka",9.6615,80.0255],
["Tashkent","Tashkent","Uzbekistan",41.2995,69.2401],
["Samarkand","Samarkand","Uzbekistan",39.6540,66.9597],
["Bishkek","Chuy","Kyrgyzstan",42.8746,74.5698],
["Osh","Osh","Kyrgyzstan",40.5283,72.7985],
["Almaty","Almaty","Kazakhstan",43.2220,76.8512],
["Nur-Sultan","Akmola","Kazakhstan",51.1801,71.4460],
["Dushanbe","Dushanbe","Tajikistan",38.5598,68.7740],
["Ashgabat","Ahal","Turkmenistan",37.9601,58.3261],
// ── South / Southeast Asia ────────────────────────────────────────────────────
["Mumbai","Maharashtra","India",19.0760,72.8777],
["Delhi","Delhi","India",28.7041,77.1025],
["Bangalore","Karnataka","India",12.9716,77.5946],
["Hyderabad","Telangana","India",17.3850,78.4867],
["Chennai","Tamil Nadu","India",13.0827,80.2707],
["Kolkata","West Bengal","India",22.5726,88.3639],
["Pune","Maharashtra","India",18.5204,73.8567],
["Ahmedabad","Gujarat","India",23.0225,72.5714],
["Yangon","Yangon","Myanmar",16.8661,96.1951],
["Naypyidaw","Naypyidaw","Myanmar",19.7450,96.1297],
["Mandalay","Mandalay","Myanmar",21.9588,96.0891],
["Myitkyina","Kachin","Myanmar",25.3833,97.3833],
["Sittwe","Rakhine","Myanmar",20.1450,92.8980],
["Bangkok","Bangkok","Thailand",13.7563,100.5018],
["Chiang Mai","Chiang Mai","Thailand",18.7883,98.9853],
["Phnom Penh","Phnom Penh","Cambodia",11.5564,104.9282],
["Battambang","Battambang","Cambodia",13.0957,103.2022],
["Vientiane","Vientiane","Laos",17.9757,102.6331],
["Hanoi","Hanoi","Vietnam",21.0285,105.8542],
["Ho Chi Minh City","Ho Chi Minh","Vietnam",10.8231,106.6297],
["Da Nang","Da Nang","Vietnam",16.0544,108.2022],
["Manila","Metro Manila","Philippines",14.5995,120.9842],
["Quezon City","Metro Manila","Philippines",14.6760,121.0437],
["Davao","Davao","Philippines",7.1907,125.4553],
["Cebu City","Cebu","Philippines",10.3157,123.8854],
["Tacloban","Leyte","Philippines",11.2543,125.0045],
["Jakarta","Jakarta","Indonesia",-6.2088,106.8456],
["Surabaya","East Java","Indonesia",-7.2575,112.7521],
["Bandung","West Java","Indonesia",-6.9175,107.6191],
["Medan","North Sumatra","Indonesia",3.5952,98.6722],
["Makassar","South Sulawesi","Indonesia",-5.1477,119.4327],
["Palu","Central Sulawesi","Indonesia",-0.8917,119.8707],
["Kuala Lumpur","Kuala Lumpur","Malaysia",3.1390,101.6869],
["Singapore","Singapore","Singapore",1.3521,103.8198],
["Dili","Dili","Timor-Leste",-8.5569,125.5789],
["Port Moresby","National Capital","Papua New Guinea",-9.4438,147.1803],
["Honiara","Guadalcanal","Solomon Islands",-9.4456,160.0003],
["Port Vila","Shefa","Vanuatu",-17.7341,168.3220],
["Suva","Central","Fiji",-18.1416,178.4415],
// ── East Asia ─────────────────────────────────────────────────────────────────
["Beijing","Beijing","China",39.9042,116.4074],
["Shanghai","Shanghai","China",31.2304,121.4737],
["Guangzhou","Guangdong","China",23.1291,113.2644],
["Shenzhen","Guangdong","China",22.5431,114.0579],
["Chengdu","Sichuan","China",30.5728,104.0668],
["Wuhan","Hubei","China",30.5928,114.3055],
["Chongqing","Chongqing","China",29.5630,106.5516],
["Hong Kong","Hong Kong","China",22.3193,114.1694],
["Lhasa","Tibet","China",29.6500,91.1000],
["Urumqi","Xinjiang","China",43.8256,87.6168],
["Tokyo","Tokyo","Japan",35.6762,139.6503],
["Osaka","Osaka","Japan",34.6937,135.5023],
["Seoul","Seoul","South Korea",37.5665,126.9780],
["Busan","Busan","South Korea",35.1796,129.0756],
["Pyongyang","Pyongyang","North Korea",39.0392,125.7625],
["Ulaanbaatar","Ulaanbaatar","Mongolia",47.8864,106.9057],
["Taipei","Taipei","Taiwan",25.0330,121.5654],
// ── Latin America / Caribbean ─────────────────────────────────────────────────
["Port-au-Prince","Ouest","Haiti",18.5944,-72.3074],
["Cap-Haïtien","Nord","Haiti",19.7572,-72.2038],
["Les Cayes","Sud","Haiti",18.2011,-73.7498],
["Caracas","Distrito Capital","Venezuela",10.4806,-66.9036],
["Maracaibo","Zulia","Venezuela",10.6354,-71.6338],
["Bogotá","Cundinamarca","Colombia",4.7110,-74.0721],
["Medellín","Antioquia","Colombia",6.2442,-75.5812],
["Cali","Valle del Cauca","Colombia",3.4516,-76.5319],
["Cúcuta","Norte de Santander","Colombia",7.8939,-72.5078],
["Buenaventura","Valle del Cauca","Colombia",3.8801,-77.0319],
["Lima","Lima","Peru",-12.0464,-77.0428],
["Arequipa","Arequipa","Peru",-16.4090,-71.5375],
["Quito","Pichincha","Ecuador",-0.1807,-78.4678],
["Guayaquil","Guayas","Ecuador",-2.1710,-79.9224],
["La Paz","La Paz","Bolivia",-16.5000,-68.1500],
["Cochabamba","Cochabamba","Bolivia",-17.3895,-66.1568],
["Santa Cruz","Santa Cruz","Bolivia",-17.7833,-63.1833],
["Santiago","Santiago","Chile",-33.4489,-70.6693],
["Valparaíso","Valparaíso","Chile",-33.0472,-71.6127],
["Buenos Aires","Buenos Aires","Argentina",-34.6037,-58.3816],
["Córdoba","Córdoba","Argentina",-31.4135,-64.1811],
["Rosario","Santa Fe","Argentina",-32.9468,-60.6393],
["Montevideo","Montevideo","Uruguay",-34.9011,-56.1645],
["Asunción","Asunción","Paraguay",-25.2867,-57.6470],
["Brasília","Federal District","Brazil",-15.7975,-47.8919],
["São Paulo","São Paulo","Brazil",-23.5505,-46.6333],
["Rio de Janeiro","Rio de Janeiro","Brazil",-22.9068,-43.1729],
["Manaus","Amazonas","Brazil",-3.1190,-60.0217],
["Salvador","Bahia","Brazil",-12.9714,-38.5014],
["Recife","Pernambuco","Brazil",-8.0476,-34.8770],
["Fortaleza","Ceará","Brazil",-3.7172,-38.5433],
["Belém","Pará","Brazil",-1.4558,-48.5044],
["Mexico City","Mexico City","Mexico",19.4326,-99.1332],
["Guadalajara","Jalisco","Mexico",20.6597,-103.3496],
["Monterrey","Nuevo León","Mexico",25.6866,-100.3161],
["Tijuana","Baja California","Mexico",32.5149,-117.0382],
["Acapulco","Guerrero","Mexico",16.8531,-99.8237],
["Tegucigalpa","Francisco Morazán","Honduras",14.0723,-87.2059],
["San Pedro Sula","Cortés","Honduras",15.5000,-88.0333],
["San Salvador","San Salvador","El Salvador",13.6929,-89.2182],
["Guatemala City","Guatemala","Guatemala",14.6349,-90.5069],
["Managua","Managua","Nicaragua",12.1328,-86.2926],
["San José","San José","Costa Rica",9.9281,-84.0907],
["Panama City","Panamá","Panama",8.9943,-79.5188],
["Havana","La Habana","Cuba",23.1136,-82.3666],
["Santo Domingo","Distrito Nacional","Dominican Republic",18.4861,-69.9312],
["Kingston","Surrey","Jamaica",17.9970,-76.7936],
["Port of Spain","Port of Spain","Trinidad and Tobago",10.6549,-61.5019],
["Georgetown","Demerara-Mahaica","Guyana",6.8013,-58.1551],
["Paramaribo","Paramaribo","Suriname",5.8520,-55.2038],
["Bridgetown","Saint Michael","Barbados",13.1132,-59.5988],
["Nassau","New Providence","Bahamas",25.0480,-77.3554],
["Belmopan","Cayo","Belize",17.2514,-88.7591],
// ── Europe ────────────────────────────────────────────────────────────────────
["London","England","United Kingdom",51.5074,-0.1278],
["Paris","Île-de-France","France",48.8566,2.3522],
["Berlin","Berlin","Germany",52.5200,13.4050],
["Madrid","Community of Madrid","Spain",40.4168,-3.7038],
["Rome","Lazio","Italy",41.9028,12.4964],
["Amsterdam","North Holland","Netherlands",52.3676,4.9041],
["Brussels","Brussels","Belgium",50.8503,4.3517],
["Vienna","Vienna","Austria",48.2082,16.3738],
["Warsaw","Masovian","Poland",52.2297,21.0122],
["Prague","Prague","Czech Republic",50.0755,14.4378],
["Budapest","Budapest","Hungary",47.4979,19.0402],
["Bucharest","Bucharest","Romania",44.4268,26.1025],
["Sofia","Sofia City","Bulgaria",42.6977,23.3219],
["Athens","Attica","Greece",37.9838,23.7275],
["Lisbon","Lisbon","Portugal",38.7223,-9.1393],
["Stockholm","Stockholm County","Sweden",59.3293,18.0686],
["Oslo","Oslo","Norway",59.9139,10.7522],
["Copenhagen","Capital Region","Denmark",55.6761,12.5683],
["Helsinki","Uusimaa","Finland",60.1699,24.9384],
["Kyiv","Kyiv","Ukraine",50.4501,30.5234],
["Kharkiv","Kharkiv","Ukraine",49.9935,36.2304],
["Mariupol","Donetsk","Ukraine",47.0956,37.5494],
["Zaporizhzhia","Zaporizhzhia","Ukraine",47.8388,35.1396],
["Lviv","Lviv","Ukraine",49.8397,24.0297],
["Minsk","Minsk City","Belarus",53.9045,27.5615],
["Moscow","Moscow","Russia",55.7558,37.6173],
["St. Petersburg","St. Petersburg","Russia",59.9343,30.3351],
["Bern","Bern","Switzerland",46.9480,7.4474],
["Zurich","Zurich","Switzerland",47.3769,8.5417],
["Geneva","Geneva","Switzerland",46.2044,6.1432],
["Luxembourg","Luxembourg","Luxembourg",49.6117,6.1319],
["Dublin","Leinster","Ireland",53.3498,-6.2603],
["Reykjavik","Capital Region","Iceland",64.1466,-21.9426],
["Tallinn","Harju","Estonia",59.4370,24.7536],
["Riga","Riga","Latvia",56.9496,24.1052],
["Vilnius","Vilnius County","Lithuania",54.6872,25.2797],
["Belgrade","Belgrade","Serbia",44.8176,20.4633],
["Sarajevo","Federation of BiH","Bosnia and Herzegovina",43.8476,18.3564],
["Zagreb","Zagreb","Croatia",45.8150,15.9819],
["Skopje","Skopje","North Macedonia",41.9981,21.4254],
["Tirana","Tirana","Albania",41.3275,19.8187],
["Podgorica","Podgorica","Montenegro",42.4304,19.2594],
["Pristina","Pristina","Kosovo",42.6629,21.1655],
["Chisinau","Chisinau","Moldova",47.0105,28.8638],
["Yerevan","Yerevan","Armenia",40.1872,44.5152],
["Tbilisi","Tbilisi","Georgia",41.6938,44.8015],
["Baku","Baku","Azerbaijan",40.4093,49.8671],
["Valletta","Southern Harbour","Malta",35.8997,14.5148],
["Ljubljana","Ljubljana","Slovenia",46.0569,14.5058],
// ── North America / Oceania ───────────────────────────────────────────────────
["Washington DC","DC","United States",38.9072,-77.0369],
["New York","New York","United States",40.7128,-74.0060],
["Los Angeles","California","United States",34.0522,-118.2437],
["Chicago","Illinois","United States",41.8781,-87.6298],
["Ottawa","Ontario","Canada",45.4215,-75.6972],
["Toronto","Ontario","Canada",43.6532,-79.3832],
["Vancouver","British Columbia","Canada",49.2827,-123.1207],
["Canberra","ACT","Australia",-35.2809,149.1300],
["Sydney","New South Wales","Australia",-33.8688,151.2093],
["Melbourne","Victoria","Australia",-37.8136,144.9631],
["Auckland","Auckland","New Zealand",-36.8485,174.7633],
["Wellington","Wellington","New Zealand",-41.2865,174.7762],
["Nuku'alofa","Tongatapu","Tonga",-21.1394,-175.2046],
["Apia","Upolu","Samoa",-13.8500,-171.7667],
["Funafuti","Funafuti","Tuvalu",-8.5211,179.1983],
["Tarawa","South Tarawa","Kiribati",1.3278,172.9756],
["Majuro","Majuro","Marshall Islands",7.1164,171.1858],
["Palikir","Pohnpei","Micronesia",6.9248,158.1618],
["Melekeok","Ngerchelong","Palau",7.5006,134.6242],
];

// ── PlaceSearch — instant offline-first location autocomplete ─────────────────
class PlaceSearch {
    constructor() {
        this._cache = {};       // query → [{name,region,country,lat,lng}]
        this._nearby = [];      // pre-fetched nearby places from device GPS area
        this._loadCache();
    }

    // Load persisted cache from localStorage
    _loadCache() {
        try {
            const raw = localStorage.getItem('crisp_place_cache');
            if (raw) this._cache = JSON.parse(raw);
        } catch (_) { this._cache = {}; }
    }

    // Persist cache (keep last 200 queries, evict oldest)
    _saveCache() {
        try {
            const keys = Object.keys(this._cache);
            if (keys.length > 200) {
                const oldest = keys.slice(0, keys.length - 200);
                oldest.forEach(k => delete this._cache[k]);
            }
            localStorage.setItem('crisp_place_cache', JSON.stringify(this._cache));
        } catch (_) {}
    }

    // Cache a result set for a query
    cacheResult(query, places) {
        const key = query.toLowerCase().trim();
        if (!key || !places.length) return;
        this._cache[key] = places;
        this._saveCache();
    }

    // Get cached results for a query
    getCached(query) {
        return this._cache[query.toLowerCase().trim()] || [];
    }

    // Search bundled cities by prefix/substring match on name or country
    _searchBundled(query) {
        const q = query.toLowerCase().trim();
        const results = [];
        for (const [name, region, country, lat, lng] of CRISP_CITIES) {
            const n = name.toLowerCase();
            const c = country.toLowerCase();
            const r = region.toLowerCase();
            // Score: start-of-name match scores highest, then contains match
            if (n.startsWith(q) || c.startsWith(q)) {
                results.push({ name, region, country, lat, lng, _score: 2 });
            } else if (n.includes(q) || c.includes(q) || r.includes(q)) {
                results.push({ name, region, country, lat, lng, _score: 1 });
            }
            if (results.length >= 20) break;
        }
        // Sort: higher score first, then alphabetical
        results.sort((a, b) => b._score - a._score || a.name.localeCompare(b.name));
        return results;
    }

    // Search nearby pre-fetched places
    _searchNearby(query) {
        const q = query.toLowerCase().trim();
        return this._nearby.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.region || '').toLowerCase().includes(q)
        );
    }

    // Score a place against the query — higher = more relevant
    _scorePlace(place, ql) {
        const nl = place.name.toLowerCase();
        if (nl === ql) return 10;                             // exact name match
        if (nl.startsWith(ql)) return 8;                     // name starts with query
        if (nl.split(/[\s\-,]+/).some(w => w.startsWith(ql))) return 5; // word starts with
        if (nl.includes(ql)) return 3;                       // name contains query
        return 1;                                             // region/country match only
    }

    // Main search: instant, no network, returns up to 5 best results
    search(query) {
        const q = query.trim();
        if (q.length < 3) return [];
        const ql = q.toLowerCase();

        // Collect all candidates from every source, deduplicate by name+country
        const seen = new Set();
        const candidates = [];
        for (const p of [...this.getCached(q), ...this._searchNearby(q), ...this._searchBundled(q)]) {
            const key = p.name.toLowerCase() + '|' + (p.country || '').toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({ ...p, _score: this._scorePlace(p, ql) });
        }

        // Sort by relevance score descending, then alphabetically
        candidates.sort((a, b) => b._score - a._score || a.name.localeCompare(b.name));
        return candidates.slice(0, 5);
    }

    // Background Nominatim search — caches results, calls callback when done
    async searchRemote(query, callback) {
        try {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            const data = await res.json();
            const places = data.map(d => {
                const addr = d.address || {};
                const name = d.display_name.split(',')[0].trim();
                const region = addr.state || addr.county || addr.suburb || '';
                const country = addr.country || '';
                return { name, region, country, lat: parseFloat(d.lat), lng: parseFloat(d.lon) };
            }).filter(p => p.name);
            if (places.length) {
                this.cacheResult(query, places);
                callback(places);
            }
        } catch (_) {
            // Offline or timeout — silent fail, local results already showing
        }
    }

    // Pre-fetch places near device GPS — called once when location is known
    async prefetchNearby(lat, lng) {
        // Check if already pre-fetched for this area
        try {
            const prev = JSON.parse(localStorage.getItem('crisp_nearby_meta') || 'null');
            if (prev) {
                const dist = Math.abs(prev.lat - lat) + Math.abs(prev.lng - lng);
                if (dist < 1.0 && this._nearby.length > 0) return; // Same area, already done
            }
        } catch (_) {}

        try {
            const delta = 1.5; // ~150km box
            const url = `https://nominatim.openstreetmap.org/search?format=json&limit=50&addressdetails=1&bounded=1` +
                `&viewbox=${lng - delta},${lat + delta},${lng + delta},${lat - delta}&q=city+OR+town+OR+village`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const data = await res.json();
            this._nearby = data.map(d => {
                const addr = d.address || {};
                return {
                    name: addr.city || addr.town || addr.village || addr.hamlet || d.display_name.split(',')[0],
                    region: addr.state || addr.county || '',
                    country: addr.country || '',
                    lat: parseFloat(d.lat),
                    lng: parseFloat(d.lon)
                };
            }).filter(p => p.name);
            localStorage.setItem('crisp_nearby_meta', JSON.stringify({ lat, lng, ts: Date.now() }));
            localStorage.setItem('crisp_nearby_places', JSON.stringify(this._nearby));
            console.log(`PlaceSearch: pre-fetched ${this._nearby.length} nearby places`);
        } catch (_) {
            // Try loading from previous session cache
            try {
                const saved = localStorage.getItem('crisp_nearby_places');
                if (saved) this._nearby = JSON.parse(saved);
            } catch (_) {}
        }
    }

    // Load nearby places from localStorage (on startup)
    loadNearbyFromCache() {
        try {
            const saved = localStorage.getItem('crisp_nearby_places');
            if (saved) this._nearby = JSON.parse(saved);
        } catch (_) {}
    }
}

// Global singleton — also exposed on `window` so test harnesses
// (Playwright's page.evaluate) and devtools can reach it. The
// script-scoped `const` alone isn't a property of the global
// object (classic-script lexical binding); v4-flow.js's
// `window.placeSearch` fallback at v4-flow.js:347 already assumed
// this exposure, but it wasn't actually being written.
const placeSearch = new PlaceSearch();
placeSearch.loadNearbyFromCache();
if (typeof window !== 'undefined') {
    window.placeSearch = placeSearch;
}
