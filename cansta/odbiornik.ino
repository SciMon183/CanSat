#include <CanSatKit.h>
#include <SD.h>
#include <FlashStorage.h>
const int CS_SDCARD = 11;



using namespace CanSatKit;

Radio radio(Pins::Radio::ChipSelect,
            Pins::Radio::DIO0,
            433.5,                  // frequency in MHz
            Bandwidth_125000_Hz,    // bandwidth - check with CanSat regulations to set allowed value
            SpreadingFactor_9,      // see provided presentations to determine which setting is the best
            CodingRate_4_6);        // see provided presentations to determine which setting is the best
File myFile;
FlashStorage(logCounterStorage, uint32_t);
bool czySD = true;


void zapiszLog(String tresc) {
  SerialUSB.println(tresc);
  if (czySD) {
    myFile.println(tresc);
    myFile.flush();
  }
}

void setup() {
  //SERIAL
  SerialUSB.begin(115200);

  //KARTA SD
  int licznik = 0;
  uint32_t logCounter;
  logCounter = logCounterStorage.read();
  if (logCounter == 0xFFFFFFFF) {
    logCounter = 0;
  }
  logCounter++;
  logCounterStorage.write(logCounter);

  while (!SD.begin(CS_SDCARD)) {
    licznik++;
    if (licznik >= 5) {
      czySD = false;
      zapiszLog("LOG|KartaSdNieDzialaOdbiornik");
      break;
    }
    delay(50);
  }

  licznik = 0;
  
  if (czySD) {
    myFile = SD.open("RX" + String(logCounter) + ".txt", FILE_WRITE);
    zapiszLog("LOG | OtwarciePlikuNaKarcieSDodbiornik");
  }



  //RADIO
  radio.begin();
}

void loop() {
  
  char data[256];

  radio.receive(data);
  String rssi = "RSSI|" + String(radio.get_rssi_last());
  zapiszLog(rssi);
  zapiszLog(data);
}
