#!/usr/bin/env python3
"""
Script to read sensor data from serial port and insert into CanSat database
Reads data in format:
- DT|millis|temp_BMP|temp_SHT|hum_SHT|cot_SCD|air_SPG|metan|wartoscFotor
- GPS|millis|latitude|longitude|distanceToHome|courseToHome|satellites
- DTP|refTEMP|press_BMP
"""

import serial
import mysql.connector
from mysql.connector import Error
import threading
import time
import sys

# Database configuration
DB_CONFIG = {
    'host': '127.0.0.1', #address of your MySQL server!!!!!
    'user': 'cansat',
    'password': 'cansat',
    'database': 'cansat'
}

# Serial port configuration
SERIAL_PORT = ''  # Change to your serial port (COM3 on Windows, /dev/ttyUSB0 on Linux)
BAUD_RATE = 115200

class SerialDataReader:
    def __init__(self, port, baudrate):
        self.port = port
        self.baudrate = baudrate
        self.serial_conn = None
        self.db_conn = None
        self.running = False
        self.stats = {'DT': 0, 'GPS': 0, 'DTP': 0, 'errors': 0}
        
    def connect_serial(self):
        """Open serial connection"""
        try:
            self.serial_conn = serial.Serial(self.port, self.baudrate, timeout=1)
            print(f"✓ Połączono z portem szeregowym: {self.port} @ {self.baudrate} baud")
            return True
        except Exception as e:
            print(f"✗ Błąd portu szeregowego: {e}")
            return False
    
    def connect_database(self):
        """Establish database connection"""
        try:
            self.db_conn = mysql.connector.connect(**DB_CONFIG)
            if self.db_conn.is_connected():
                print("✓ Połączono z bazą danych")
                return True
        except Error as e:
            print(f"✗ Błąd bazy danych: {e}")
            return False
    
    def parse_dt_data(self, data):
        """Parse DT (sensor data) format: DT|millis|temp_BMP|temp_SHT|hum_SHT|cot_SCD|air_SPG|metan|wartoscFotor"""
        try:
            parts = data.split('|')
            if len(parts) != 9:
                print(f"✗ DT: Błędna liczba pól ({len(parts)}, oczekiwano 9)")
                return None
            
            millis = int(parts[1])
            temp_BMP = parts[2]
            temp_SHT = parts[3]
            hum_SHT = parts[4]
            cot_SCD = parts[5]
            air_SPG = parts[6]
            metan = int(parts[7])
            wartoscFotor = int(parts[8])
            
            return {
                'millis': millis,
                'temp_BMP': temp_BMP,
                'temp_SHT': temp_SHT,
                'hum_SHT': hum_SHT,
                'cot_SCD': cot_SCD,
                'air_SPG': air_SPG,
                'metan': metan,
                'wartoscFotor': wartoscFotor
            }
        except Exception as e:
            print(f"✗ DT: Błąd parsowania: {e}")
            return None
    
    def parse_gps_data(self, data):
        """Parse GPS format: GPS|millis|latitude|longitude|distanceToHome|courseToHome|satellites"""
        try:
            parts = data.split('|')
            if len(parts) != 8:
                print(f"✗ GPS: Błędna liczba pól ({len(parts)}, oczekiwano 8)")
                return None
            
            millis = int(parts[1])
            latitude = float(parts[2])
            longitude = float(parts[3])
            distanceToHome = int(parts[4])
            courseToHome = float(parts[5])
            satellites = int(parts[6])
            
            return {
                'millis': millis,
                'latitude': latitude,
                'longitude': longitude,
                'distanceToHome': distanceToHome,
                'courseToHome': courseToHome,
                'satellites': satellites
            }
        except Exception as e:
            print(f"✗ GPS: Błąd parsowania: {e}")
            return None
    
    def parse_dtp_data(self, data):
        """Parse DTP format: DTP|refTEMP|press_BMP"""
        try:
            parts = data.split('|')
            if len(parts) != 4:
                print(f"✗ DTP: Błędna liczba pól ({len(parts)}, oczekiwano 4)")
                return None
            
            refTEMP = float(parts[1])
            press_BMP = parts[2]
            
            return {
                'refTEMP': refTEMP,
                'press_BMP': press_BMP
            }
        except Exception as e:
            print(f"✗ DTP: Błąd parsowania: {e}")
            return None
    
    def insert_dt(self, data):
        """Insert DT data into database"""
        try:
            cursor = self.db_conn.cursor()
            query = """INSERT INTO DT (millis, temp_BMP, temp_SHT, hum_SHT, cot_SCD, air_SPG, metan, wartoscFotor)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"""
            
            cursor.execute(query, (data['millis'], data['temp_BMP'], data['temp_SHT'],
                                  data['hum_SHT'], data['cot_SCD'], data['air_SPG'],
                                  data['metan'], data['wartoscFotor']))
            self.db_conn.commit()
            cursor.close()
            self.stats['DT'] += 1
            print(f"✓ DT wstawiony: millis={data['millis']}, temp_BMP={data['temp_BMP']}°C")
            
        except Error as e:
            print(f"✗ Błąd wstawienia DT: {e}")
            self.stats['errors'] += 1
    
    def insert_gps(self, data):
        """Insert GPS data into database"""
        try:
            cursor = self.db_conn.cursor()
            query = """INSERT INTO GPS (millis, latitude, longitude, distanceToHome, courseToHome, satellites)
                       VALUES (%s, %s, %s, %s, %s, %s)"""
            
            cursor.execute(query, (data['millis'], data['latitude'], data['longitude'],
                                  data['distanceToHome'], data['courseToHome'],
                                  data['satellites']))
            self.db_conn.commit()
            cursor.close()
            self.stats['GPS'] += 1
            print(f"✓ GPS wstawiony: lat={data['latitude']:.6f}, lng={data['longitude']:.6f}")
            
        except Error as e:
            print(f"✗ Błąd wstawienia GPS: {e}")
            self.stats['errors'] += 1
    
    def insert_dtp(self, data):
        """Insert DTP data into database"""
        try:
            cursor = self.db_conn.cursor()
            query = """INSERT INTO DTP (refTEMP, press_BMP)
                       VALUES (%s, %s)"""
            
            cursor.execute(query, (data['refTEMP'], data['press_BMP']))
            self.db_conn.commit()
            cursor.close()
            self.stats['DTP'] += 1
            print(f"✓ DTP wstawiony: temp={data['refTEMP']}°C, press={data['press_BMP']}")
            
        except Error as e:
            print(f"✗ Błąd wstawienia DTP: {e}")
            self.stats['errors'] += 1
    
    def process_line(self, line):
        """Process a single line from serial port"""
        line = line.strip()
        if not line:
            return
        
        print(f"→ Odebrano: {line}")
        
        if line.startswith('DT|'):
            data = self.parse_dt_data(line)
            if data:
                self.insert_dt(data)
        
        elif line.startswith('GPS|'):
            data = self.parse_gps_data(line)
            if data:
                self.insert_gps(data)
        
        elif line.startswith('DTP|'):
            data = self.parse_dtp_data(line)
            if data:
                self.insert_dtp(data)
        
        else:
            print(f"✗ Nieznany format: {line[:20]}...")
    
    def run(self):
        """Main loop"""
        print("\n" + "="*60)
        print("CanSat - Czytnik Portu Szeregowego")
        print("="*60)
        
        if not self.connect_serial():
            return
        
        if not self.connect_database():
            self.serial_conn.close()
            return
        
        self.running = True
        print(f"\n✓ System gotowy. Czekam na dane...\n")
        
        try:
            while self.running:
                if self.serial_conn.in_waiting > 0:
                    try:
                        line = self.serial_conn.readline().decode('utf-8', errors='ignore')
                        if line:
                            self.process_line(line)
                    except UnicodeDecodeError as e:
                        print(f"✗ Błąd dekodowania: {e}")
                        self.stats['errors'] += 1
                
                time.sleep(0.1)
        
        except KeyboardInterrupt:
            print("\n\n" + "="*60)
            print("Zatrzymywanie pracy...")
            print("="*60)
        
        finally:
            self.cleanup()
    
    def cleanup(self):
        """Close connections and print statistics"""
        self.running = False
        
        if self.serial_conn and self.serial_conn.is_open:
            self.serial_conn.close()
            print("✓ Port szeregowy zamknięty")
        
        if self.db_conn and self.db_conn.is_connected():
            self.db_conn.close()
            print("✓ Baza danych rozłączona")
        
        print("\n" + "="*60)
        print("STATYSTYKA:")
        print(f"  DT wpisy:    {self.stats['DT']}")
        print(f"  GPS wpisy:   {self.stats['GPS']}")
        print(f"  DTP wpisy:   {self.stats['DTP']}")
        print(f"  Błędy:       {self.stats['errors']}")
        print("="*60 + "\n")

def main():
    """Main function"""
    reader = SerialDataReader(SERIAL_PORT, BAUD_RATE)
    reader.run()

if __name__ == "__main__":
    main()
