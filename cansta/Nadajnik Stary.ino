asm(".global _printf_float"); // Umożliwia używanie floatów razem z snprintf

#define ALT_BMP //trzeba wybrać czy BMP czy GPS robi wysokość
//#define ALT_GPS
#define AUTO_ALT_ARMING // przejście 
#define AUTO_ALT_DISARMING
//#define MANUAL_DISARMING
//#define SERIAL_USB_DEBUG //tego nie potrzebujemy
#define AUTO_PHOTOR_ACTIVATING // przejscie z 1 na 2 za pomocą fotorezystora

constexpr int AUTO_ARMING_ALT_AGL = 100; // Granizcna wysokośc AGL przejścia stanów
constexpr int VTX_TURN_OFF_ALT_AGL = 50;
constexpr int TIME_TO_POWER_OFF_VTX = 4 * 60 * 1000;  // Oczywiście po spadnięciu poniżej zadanej wysokości

#include <CanSatKit.h>
#include <FlashStorage.h>
#include <SD.h>
#include <DFRobot_SCD4X.h>
#include <DFRobot_SGP40.h>
#include <DFRobot_SHT3x.h>
#include <Adafruit_BMP280.h>
#include <TinyGPSPlus.h>
#include <hdzero.h>

using namespace CanSatKit;

// ------ PINY ------
constexpr int PIN_METHAN = A2;
constexpr int PIN_PHOTORESISTOR = A4;
constexpr int PIN_MOSFT_SERVO = A1;
constexpr int PIN_MOSFET_VTX = A0;
constexpr int PIN_CS_SDCARD = 11;
constexpr int PIN_PWM_STATUS = 7;

Radio radio(Pins::Radio::ChipSelect, Pins::Radio::DIO0, 433.5, Bandwidth_125000_Hz, SpreadingFactor_9, CodingRate_4_6);
File myFile;
FlashStorage(logCounterStorage, uint32_t);
DFRobot_SCD4X SCD4X(&Wire, /*i2cAddr = */ SCD4X_I2C_ADDR);
DFRobot_SGP40 mySgp40;
DFRobot_SHT3x sht3x;
Adafruit_BMP280 bmp;
TinyGPSPlus gps;
HDZero hdzero;

bool isOkSD = true, isOkSCD = true, isOkSPG = true, isOkSHT = true, isOkBMP = true; //Flagi inicjacji czujników

char tempBMP[12] = "NA";
char pressBMP[16] = "NA";
char tempSHT[12] = "NA";
char humSHT[12] = "NA";
char cotSCD[12] = "NA";
char airSPG[12] = "NA";
int methanValue = 0;

float refTEMP = 20, refHUM = 50;  //Używane głownie do kalibracji czujników np CO2

unsigned long last_PhotoresistorMeasure=0, last_updateStatus=0, last_updateOSD = 0, last_sendSensors = 0,
 last_wSrodku = 0, last_updateDistanceToHome = 0, last_updateCourseToHome = 0, last_sendLocation=0,
 last_sendSensorsPrimary=0, last_SDCardFlush = 0, last_countdownToTurnOffVTX=0;

bool isHomeCoordsSet = false, isHomeAltSet = false; //Zmienne Home
double latHome, lngHome;
unsigned long distanceToHome;
int courseToHome;
int altHomeAMSL;
int altAMSL = 230; // Ustawione na pałe w razie co

volatile unsigned long STATUS_pwmTimerStart = 0;
volatile int STATUS_pwmRawValue = 0; // Domyślnie środek (1500us)
int STATUS_switchState = 0; // 0 - dół, 1 - środek, 2 - góra

int statusPhase = 0, photorMeasuresCounter = 0, photorValue = 0;
bool photorSeparationDetected = false, photorTakeMeasures = false, photorWaitsForSeparation = false;
uint32_t photorSumOfMeasures = 0;

void STATUSreadPWM() {
  unsigned long teraz = micros();
  if (digitalRead(PIN_PWM_STATUS)) {
    STATUS_pwmTimerStart = teraz;
  } else {
    unsigned long roznica = teraz - STATUS_pwmTimerStart;
    if (roznica < 2300) { 
        STATUS_pwmRawValue = (int)roznica;
    }
  }
}
void sendSaveMessage(const char* content) {
  #ifdef SERIAL_USB_DEBUG
  SerialUSB.println(content);
  #endif

  if (isOkSD) {
    myFile.println(content);
    if(millis() - last_SDCardFlush >= 7 * 1000){
      last_SDCardFlush = millis();
      myFile.flush();
    }
  }

  if (!radio.transmit(content)) {
    
    #ifdef SERIAL_USB_DEBUG
    SerialUSB.println("LOG|ProblemZTransmisjaRamki");
    #endif

    if (isOkSD) {
      myFile.println("LOG|ProblemZTransmisjaRamki");
    }
  }
}
void sendLocation() {
  char buffer[100];

  snprintf(buffer, sizeof(buffer),
         "GPS|%.7f|%.7f|%lu|%d|%d|%lu",
         gps.location.lat(),
         gps.location.lng(),
         distanceToHome,
         courseToHome,
         altAMSL - altHomeAMSL, // To jest AGL
         gps.satellites.value());

  sendSaveMessage(buffer);
}
void sendSensordPrimary() {
  if (isOkBMP) {
    float t = bmp.readTemperature();
    refTEMP = t;
    float p = bmp.readPressure();

    snprintf(tempBMP, sizeof(tempBMP), "%.2f", t);
    snprintf(pressBMP, sizeof(pressBMP), "%.2f", p);

    #ifdef ALT_BMP
      altAMSL = bmp.readAltitude(1013.25);
      if(isHomeAltSet == false){
         altHomeAMSL = altAMSL;
         isHomeAltSet = true;
      }
    #endif
  }

  if (isOkSHT) {
    refTEMP = sht3x.getTemperatureC();
    refHUM = sht3x.getHumidityRH();

    snprintf(tempSHT, sizeof(tempSHT), "%.2f", refTEMP);
    snprintf(humSHT, sizeof(humSHT), "%.2f", refHUM);
  }

  char buffer[80];

  snprintf(buffer, sizeof(buffer),
           "DTP|%.2f|%s",
           refTEMP,
           pressBMP);

  sendSaveMessage(buffer);
}
void sendSensors() {

  if (isOkSCD) {
    if (SCD4X.getDataReadyStatus()) {
      DFRobot_SCD4X::sSensorMeasurement_t data;
      SCD4X.readMeasurement(&data);
      
      snprintf(cotSCD, sizeof(cotSCD), "%d", data.CO2ppm);
    }
  }

  if (isOkSPG) {
    int vocIndex = mySgp40.getVoclndex();
    snprintf(airSPG, sizeof(airSPG), "%d", vocIndex);
  }

  methanValue = analogRead(PIN_METHAN);

  char buffer[160];

  snprintf(buffer, sizeof(buffer),
           "DT|%lu|%s|%s|%s|%s|%s|%d|%d",
           millis(),
           tempBMP,
           tempSHT,
           humSHT,
           cotSCD,
           airSPG,
           methanValue,
           photorValue);

  sendSaveMessage(buffer);
}
void updateOSD() { //FUMCJA WYSWIETLACJACA OSD NA EKRANIE GOGLI FPV
  char buf1[10], buf2[16], buf3[16];

  snprintf(buf1, sizeof(buf1), "%.1f", courseToHome);
  snprintf(buf2, sizeof(buf2), "ALT: %dM", altAMSL - altHomeAMSL); // wychodzi alt_AGL
  snprintf(buf3, sizeof(buf3), "DS: %luM", distanceToHome);

  hdzero.clear();
  hdzero.writeString(0, 2, 3, buf3);
  hdzero.writeString(0, 25, 3, buf1);
  hdzero.writeString(0, 39, 3, buf2);
  hdzero.draw();
}
void setup() {

  
  #ifdef SERIAL_USB_DEBUG
  SerialUSB.begin(115200);
  #endif

  //MOSFTETY 
  pinMode(PIN_MOSFT_SERVO, OUTPUT);
  digitalWrite(PIN_MOSFT_SERVO,LOW);

  pinMode(PIN_MOSFET_VTX, OUTPUT);
  digitalWrite(PIN_MOSFET_VTX, LOW);

  //PWM
  pinMode(PIN_PWM_STATUS, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_PWM_STATUS), STATUSreadPWM, CHANGE);

  //GPS
  delay(100);
  Serial.begin(115200);

  //OSD VTX
  Serial1.begin(115200);
  while (!Serial1) ;
  hdzero.begin(Serial1);
  hdzero.setFcVariant("INAV");
  hdzero.setResolution(HD_5018);

  int failCounter = 0;

  //SD CARD
  uint32_t logCounter;
  logCounter = logCounterStorage.read();
  if (logCounter == 0xFFFFFFFF) {
    logCounter = 0;
  }
  logCounter++;
  logCounterStorage.write(logCounter);

  while (!SD.begin(PIN_CS_SDCARD)) {
    failCounter++;
    if (failCounter >= 5) {
      isOkSD = false;
      sendSaveMessage("LOG|SdNieDziala");
      break;
    }
    delay(50);
  }
  failCounter = 0;

  if (isOkSD) {
    char filename[20];
    snprintf(filename, sizeof(filename), "TX%lu.txt", logCounter);
    myFile = SD.open(filename, FILE_WRITE);

    sendSaveMessage("LOG|OtwarciePlikuSD");
  }

  //RADIO LORA 433
  while (!radio.begin()) {
    delay(10);
    sendSaveMessage("LOG|RADIO_BLAD");
  }
  radio.disable_debug();

  //CO2 SCD41
  while (!SCD4X.begin()) {
    sendSaveMessage("LOG|SCD41_CO2_BLAD");
    delay(50);
    failCounter++;
    if (failCounter >= 5) {
      sendSaveMessage("LOG|SCD41_CO2_BLAD");
      isOkSCD = false;
      break;
    }
  }

  failCounter = 0;
  if (isOkSCD) {
    SCD4X.enablePeriodMeasure(SCD4X_STOP_PERIODIC_MEASURE);
    delay(200);
    SCD4X.setSensorAltitude(altAMSL);
    SCD4X.enablePeriodMeasure(SCD4X_START_PERIODIC_MEASURE);
  }

  //air qualiy spg40
  while (mySgp40.begin(/*duration = */ 100) != true) {
    sendSaveMessage("LOG|SPG40_BLAD");
    delay(50);
    failCounter++;
    if (failCounter >= 5) {
      sendSaveMessage("LOG|SPG40_BLAD");
      isOkSPG = false;
      break;
    }
  }
  failCounter = 0;

  //SHT31 temp i wilgotnosc
  while (sht3x.begin() != 0) {
    sendSaveMessage("LOG|SHT31_BLAD");
    delay(50);
    failCounter++;
    if (failCounter >= 5) {
      sendSaveMessage("LOG|SHT31_BLAD");
      isOkSHT = false;
      break;
    }
  }
  failCounter = 0;

  //BMP no to wiadomka
  if (!bmp.begin(0x76)) {
    sendSaveMessage("LOG|BMP_BLAD");
    isOkBMP = false;
  } else {
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,  /* Operating Mode. */
                    Adafruit_BMP280::SAMPLING_X2,  /* Temp. oversampling */
                    Adafruit_BMP280::SAMPLING_X16, /* Pressure oversampling */
                    Adafruit_BMP280::FILTER_X16,   /* Filtering. */
                    Adafruit_BMP280::STANDBY_MS_500);
  }

  sendSaveMessage("LOG|START");
}
void loop() {
  
  hdzero.run(); //Musi tu to być żeby OSD działało


  //SECKJA GPS
  while (Serial.available()){ // UPDATE DANYCH Z GPS
    gps.encode(Serial.read());
  }
  if(gps.location.isUpdated() && gps.altitude.isValid()){ //
    
    if(isHomeCoordsSet == false && gps.satellites.value() >= 4){
      isHomeCoordsSet = true;
      sendSaveMessage("LOG|HomeFixed");
      latHome = gps.location.lat();
      lngHome = gps.location.lng();

      #ifdef ALT_BMP
        if(isOkBMP == false){
          altHomeAMSL = (int)gps.altitude.meters();
          isHomeAltSet = true;
          sendSaveMessage("LOG|HomeFixed");
        }  // Awaryjnie czytamy z GPS
      #endif

      #ifdef ALT_GPS
        altHomeAMSL = (int)gps.altitude.meters();
        isHomeAltSet = true;
      #endif
      
    }
    
    #ifdef ALT_GPS
      altAMSL = (int)gps.altitude.meters();
    #endif

    if (millis() - last_updateCourseToHome >= 300) { //UPDATE KURSU DO DOMU
      courseToHome = TinyGPSPlus::courseTo(gps.location.lat(), gps.location.lng(), latHome, lngHome) - gps.course.deg();
      if (courseToHome > 180) courseToHome -= 360;
      if (courseToHome < -180) courseToHome += 360;
      last_updateCourseToHome = millis();
    }

    if (millis() - last_updateDistanceToHome >= 1000) { // UPDATE DYSTANSU DO DOMU
      distanceToHome = (unsigned long)TinyGPSPlus::distanceBetween(gps.location.lat(), gps.location.lng(), latHome, lngHome);
      last_updateDistanceToHome = millis();
    }

    if (millis() - last_sendLocation >= 2600) {
      sendLocation();
      last_sendLocation = millis();
    }
  }

  //SENSORY
  if (millis() - last_sendSensorsPrimary >= 900) {
    sendSensordPrimary();
    last_sendSensorsPrimary = millis();
  }

  if (millis() - last_sendSensors >= 5000) {
    sendSensors();
    last_sendSensors = millis();
  }

  //OSD
  if (millis() - last_updateOSD >= 300) {
    updateOSD();
    last_updateOSD = millis();
  }


  if(millis() - last_updateStatus >= 300){
    last_updateStatus = millis();
    
    // ------ SPRAWDZENIE STANU PRZELACZNIKA NA RADIOMASTERZE -----
    noInterrupts();
    int pwm = STATUS_pwmRawValue;
    interrupts();
    // if(pwm > 1800){ // powinno wyłapywać 2012
    //   STATUS_switchState = 2;
    // }

    // else if(pwm < 1200){ // powinno wyłapywać 988
    //   STATUS_switchState = 0;
    // }
      
    // else { //powinno 1500 wyłapywać
    //   STATUS_switchState = 1;
    // }
        if(pwm > 2000 && pwm < 2300){ // powinno wyłapywać 2012
      STATUS_switchState = 2;
    }

    else if(pwm < 1200 && pwm > 950){ // powinno wyłapywać 988
      STATUS_switchState = 0;
    }
      
    else if(pwm > 1450 && pwm < 1800){ //powinno 1500 wyłapywać
      STATUS_switchState = 1;
    }  



    // ------ OBSŁUGA STATUSU CANSATA -----
    if(statusPhase == 0 && STATUS_switchState == 1){ // z 0 na 1 Manualnie
      statusPhase = 1;
      digitalWrite(PIN_MOSFET_VTX, HIGH);

      photorTakeMeasures = true;
      photorMeasuresCounter = 0;
      photorSumOfMeasures = 0;

      sendSaveMessage("LOG|0na1Man");

    }
    #ifdef AUTO_ALT_ARMING
      if(statusPhase == 0 && altAMSL - altHomeAMSL >= AUTO_ARMING_ALT_AGL && isHomeAltSet){ // z 0 na 1 Po wysokości automatycznie
        statusPhase = 1;
        digitalWrite(PIN_MOSFET_VTX, HIGH);

        photorTakeMeasures = true;
        photorMeasuresCounter = 0;
        photorSumOfMeasures = 0;

        sendSaveMessage("LOG|0na1Alt");
      }
    #endif
    if(statusPhase == 1 && STATUS_switchState == 0 && altAMSL - altHomeAMSL < AUTO_ARMING_ALT_AGL && isHomeAltSet){ //powrot z 1 na 0 Manualnie ale tylko jak poniżej LIMIT
      statusPhase = 0;
      digitalWrite(PIN_MOSFET_VTX, LOW);

      photorTakeMeasures = false;
      photorWaitsForSeparation = false;

      sendSaveMessage("LOG|1na0Man");
    }
    if(statusPhase==1 && STATUS_switchState == 2){ // z 1 na 2 Manualnie
      statusPhase = 2;
      digitalWrite(PIN_MOSFET_VTX, HIGH);
      digitalWrite(PIN_MOSFT_SERVO, HIGH);
      photorWaitsForSeparation = false;

      sendSaveMessage("LOG|1na2Man");
    }
    #ifdef AUTO_PHOTOR_ACTIVATING 
      if(statusPhase==1 && photorSeparationDetected == true){ // z 1 na 2 Auto Fotorezystor
        statusPhase = 2;
        digitalWrite(PIN_MOSFET_VTX, HIGH);
        digitalWrite(PIN_MOSFT_SERVO, HIGH);
        photorWaitsForSeparation = false;

        sendSaveMessage("LOG|1na2Fotor");
      }
    #endif
    #ifdef MANUAL_DISARMING
    //Jebać to
    #endif
    #ifdef AUTO_ALT_DISARMING
      if(statusPhase == 2 && altAMSL - altHomeAMSL < VTX_TURN_OFF_ALT_AGL && isHomeAltSet){
        statusPhase = 3;
        last_countdownToTurnOffVTX = millis();
        sendSaveMessage("LOG|Odliczanie2na4Alt");
      }
      if(statusPhase == 3 && millis() - last_countdownToTurnOffVTX >= TIME_TO_POWER_OFF_VTX){
        statusPhase = 4;
        digitalWrite(PIN_MOSFET_VTX, LOW);
        sendSaveMessage("LOG|WylaczanieVTX");
      }
    #endif
  }

  //OBSŁUGA FOTOREZYSOTRA
  #ifdef AUTO_PHOTOR_ACTIVATING 
    if(photorTakeMeasures){
      if(millis()- last_PhotoresistorMeasure >= 50){
        last_PhotoresistorMeasure = millis();
        photorValue = analogRead(PIN_PHOTORESISTOR);
        photorSumOfMeasures+=photorValue;
        photorMeasuresCounter++;
      }
      if(photorMeasuresCounter >= 40) {
        photorTakeMeasures = false;
        photorMeasuresCounter = 0;
        photorWaitsForSeparation = true;
      }
    }
    if(photorWaitsForSeparation){
      if(millis() - last_PhotoresistorMeasure >= 50){  
        last_PhotoresistorMeasure = millis();
        photorValue = analogRead(PIN_PHOTORESISTOR);
        if(photorValue < (photorSumOfMeasures / 40.0) * 0.50){
          photorMeasuresCounter++;
        }
        
        if(photorMeasuresCounter >= 10) {
          photorWaitsForSeparation = false;
          photorSeparationDetected = true;
          sendSaveMessage("LOG|FotorWykyrlOdlot");
        }
      }
    }
  #endif

}